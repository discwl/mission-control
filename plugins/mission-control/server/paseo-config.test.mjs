import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createPaseoInstructions, readPaseoInstructions } = require("./paseo-config.ts");
const { getDeliveryInstructions, listBranchGuidance } = require("../shared/paseo-metadata.ts");

const serverId = "srv_test";
const taskId = "task_1234abcd-0000-4000-8000-000000000000";
const runId = "run_1234abcd-0000-4000-8000-000000000000";
const branch = "task/1234abcd-add-greeting";
const config = metadata => JSON.stringify({ worktree: { setup: "npm ci" }, metadataGeneration: metadata }, null, 2);

/** A repository with a task worktree, a task folder with a run and its handoff, and Mission Control's reader. */
async function scenario(t, { ticket } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "mission-paseo-json-")));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const repo = join(base, "repo");
  const worktree = join(base, "worktrees", "1234abcd-add-greeting");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "master", repo]);
  git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "base.txt"), "base\n");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "base");
  git(repo, "worktree", "add", "-q", "-b", branch, worktree, "master");

  const folder = join(base, "vault", "Tasks", taskId);
  await mkdir(join(folder, "runs", runId), { recursive: true });
  await writeFile(join(folder, "runs", runId, "handoff.md"), "---\nrunId: x\n---\n\n# Handoff\n\nAdds a greeting file.\n\n## Evidence\n\n- secret-looking detail that isn't the summary\n");
  const task = {
    taskId, projectId: "prj_test", title: "ABC-7 · Add greeting", status: "in_review", assignments: [{ serverId, workspaceId: "wks_task" }],
    worktree: { workspaceId: "wks_task", branch, baseCommit: git(repo, "rev-parse", "HEAD"), sourceWorkspaceId: "wks_main", createdAt: "2026-09-20T00:00:00Z" },
    ...(ticket ? { ticket } : {}),
  };
  const reader = createPaseoInstructions({
    sources: async () => [{ task, folder, file: join(folder, "task.md") }],
    projectRoot: async () => repo,
    runs: async () => [{ runId }],
  });
  const forTask = async () => getDeliveryInstructions.output.parse(await reader.forTask({ serverId, taskId }, {}));
  return { base, repo, worktree, git, reader, forTask };
}

test("paseo.json is read from the task worktree first", async t => {
  const s = await scenario(t);
  await writeFile(join(s.repo, "paseo.json"), config({ commitMessage: { instructions: "From the main checkout." } }));
  await writeFile(join(s.worktree, "paseo.json"), config({ commitMessage: { instructions: "Use Conventional Commits." }, pullRequest: { instructions: "Start with ## Why." }, branchName: { instructions: "feature/<slug>" } }));
  const { instructions } = await s.forTask();
  assert.deepEqual(instructions, {
    commitMessage: "Use Conventional Commits.", pullRequest: "Start with ## Why.", branchName: "feature/<slug>",
    path: join(s.worktree, "paseo.json"), where: "worktree", problem: null,
  });
});

test("an uncommitted paseo.json in the source checkout is used when the worktree has none", async t => {
  const s = await scenario(t);
  const file = join(s.repo, "paseo.json");
  const text = config({ commitMessage: { instructions: "  Imperative mood, under 72 characters.  " } });
  await writeFile(file, text);
  const before = await stat(file);
  const { instructions } = await s.forTask();
  assert.equal(instructions.where, "source");
  assert.equal(instructions.path, join(s.repo, "paseo.json"));
  assert.equal(instructions.commitMessage, "Imperative mood, under 72 characters.");
  assert.equal(instructions.pullRequest, null);
  // Read only: the file is exactly as it was.
  assert.equal(await readFile(file, "utf8"), text);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
});

test("no paseo.json anywhere gives no instructions and no problem", async t => {
  const s = await scenario(t);
  const { instructions } = await s.forTask();
  assert.deepEqual(instructions, { commitMessage: null, pullRequest: null, branchName: null, path: null, where: null, problem: null });
});

test("an invalid paseo.json is reported and its instructions aren't used, even when the source checkout has a valid one", async t => {
  const s = await scenario(t);
  await writeFile(join(s.worktree, "paseo.json"), "{ \"metadataGeneration\": { ");
  await writeFile(join(s.repo, "paseo.json"), config({ commitMessage: { instructions: "Not this one." } }));
  const { instructions } = await s.forTask();
  assert.equal(instructions.commitMessage, null);
  assert.equal(instructions.where, "worktree");
  assert.match(instructions.problem, /paseo\.json isn't valid JSON .*so its instructions aren't used\./);
});

test("entries of the wrong shape are ignored, as Paseo's own schema does", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mission-paseo-shape-")));
  try {
    const read = () => readPaseoInstructions([{ directory: null, where: "worktree" }, { directory: dir, where: "source" }]);
    await writeFile(join(dir, "paseo.json"), JSON.stringify({ metadataGeneration: { commitMessage: { instructions: 5 }, pullRequest: "oops", branchName: { instructions: "   " } } }));
    assert.deepEqual({ ...(await read()), path: null }, { commitMessage: null, pullRequest: null, branchName: null, path: null, where: "source", problem: null });
    await writeFile(join(dir, "paseo.json"), JSON.stringify({ metadataGeneration: "nope" }));
    assert.equal((await read()).problem, null);
    await writeFile(join(dir, "paseo.json"), JSON.stringify([1, 2]));
    assert.equal((await read()).commitMessage, null);
    // A byte order mark is fine, and long instructions are clipped.
    await writeFile(join(dir, "paseo.json"), `﻿${JSON.stringify({ metadataGeneration: { pullRequest: { instructions: "x".repeat(5_000) } } })}`);
    assert.equal((await read()).pullRequest.length, 4_000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the task facts given to the model: title, ticket and the handoff summary only", async t => {
  const ticket = { system: "jira", key: "ABC-7", url: "https://example.atlassian.net/browse/ABC-7", type: "Story" };
  const s = await scenario(t, { ticket });
  const info = await s.forTask();
  assert.equal(info.title, "ABC-7 · Add greeting");
  assert.deepEqual(info.ticket, { key: "ABC-7", url: "https://example.atlassian.net/browse/ABC-7" });
  assert.equal(info.summary, "Adds a greeting file.");
  await assert.rejects(s.reader.forTask({ serverId: "srv_other", taskId }, {}), /isn't on this host/);
});

test("Branch names reads each Git project's branch guidance from its checkout, with the file it came from", async t => {
  const s = await scenario(t);
  const other = join(s.base, "other");
  await mkdir(other);
  await writeFile(join(s.repo, "paseo.json"), config({ branchName: { instructions: "Use feature/<ticket>-<slug>." } }));
  await writeFile(join(other, "paseo.json"), "not json");
  const paseo = { projects: { list: async () => ({ projects: [
    { projectId: "prj_a", projectKind: "git", projectRootPath: s.repo },
    { projectId: "prj_b", projectKind: "git", projectRootPath: other },
    { projectId: "prj_c", projectKind: "git", projectRootPath: join(s.base, "gone") },
    { projectId: "prj_d", projectKind: "folder", projectRootPath: s.repo },
  ] }) } };
  const { projects } = listBranchGuidance.output.parse(await s.reader.branchGuidance(paseo));
  assert.deepEqual(projects.map(project => project.projectId), ["prj_a", "prj_b", "prj_c"]);
  assert.deepEqual(projects[0], { projectId: "prj_a", guidance: "Use feature/<ticket>-<slug>.", path: join(s.repo, "paseo.json"), problem: null });
  assert.equal(projects[1].guidance, null);
  assert.match(projects[1].problem, /isn't valid JSON/);
  assert.match(projects[2].problem, /The project's folder can't be read/);
});
