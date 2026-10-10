import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function taskMarkdown(fields) {
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n# Concurrent writer fixture\n`;
}

async function compileFixture(runtime, vault) {
  await mkdir(join(runtime, "server"), { recursive: true });
  await mkdir(join(runtime, "shared"), { recursive: true });
  await writeFile(join(runtime, "package.json"), '{"type":"commonjs"}');
  for (const name of ["shared/tasks", "shared/task-summary", "server/retrying-rename", "server/tasks"]) {
    const original = await readFile(join(pluginRoot, `${name}.ts`), "utf8");
    const source = name === "server/tasks"
      ? original.replace(/^const vaultRoot = .*;$/m, `const vaultRoot = ${JSON.stringify(vault)};`)
      : original;
    if (name === "server/tasks") assert.notEqual(source, original, "fixture must redirect the vault root");
    const javascript = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: `${name}.ts`,
    }).outputText;
    await writeFile(join(runtime, `${name}.js`), javascript);
  }
  return require(join(runtime, "server", "tasks.js"));
}

test("concurrent document and status updates cannot both win from one revision", async t => {
  const runtime = await mkdtemp(join(pluginRoot, ".test-runtime-"));
  const vault = await mkdtemp(join(tmpdir(), "mission-control-vault-"));
  t.after(async () => {
    assert.ok(runtime.startsWith(`${pluginRoot}${sep}`));
    assert.ok(vault.startsWith(`${tmpdir()}${sep}`));
    await rm(runtime, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  });

  const serverId = "srv_test";
  const workspaceId = "wks_test";
  const taskId = `task_${randomUUID()}`;
  const folder = join(vault, "Tasks", taskId);
  const note = join(folder, "notes.md");
  const updatedAt = "2026-01-01T00:00:00.000Z";
  await mkdir(folder, { recursive: true });
  await writeFile(join(vault, "host.json"), JSON.stringify({ schemaVersion: 1, hostId: "personal", serverId }));
  await writeFile(join(folder, "task.md"), taskMarkdown({
    schemaVersion: 1, taskId, hostId: "personal", projectId: "prj_test",
    title: "Concurrent writer fixture", acceptanceCriteria: "Only one writer succeeds.",
    status: "inbox", source: "manual", assignments: [{ serverId, workspaceId }],
    createdAt: updatedAt, updatedAt,
  }));
  await writeFile(note, "# Notes\n");
  const tasks = await compileFixture(runtime, vault);
  const input = { serverId, workspaceId, taskId };

  const listed = await tasks.listTaskDocumentRecords(serverId, workspaceId, taskId);
  const revision = listed.documents.find(document => document.name === "notes.md").revision;
  const writes = await Promise.allSettled([
    tasks.saveTaskDocumentRecord({ ...input, name: "notes.md", content: "# First\n", revision }),
    tasks.saveTaskDocumentRecord({ ...input, name: "notes.md", content: "# Second\n", revision }),
  ]);
  const saved = writes.filter(result => result.status === "fulfilled");
  assert.equal(saved.length, 1, "exactly one document save must succeed");
  assert.equal(writes.filter(result => result.status === "rejected").length, 1);
  assert.equal(await readFile(note, "utf8"), saved[0].value.content);
  assert.equal(existsSync(join(folder, ".mission-control-write.lock")), false);

  const statuses = await Promise.allSettled([
    tasks.updateTaskStatusRecord({ ...input, status: "ready", expectedUpdatedAt: updatedAt }),
    tasks.updateTaskStatusRecord({ ...input, status: "blocked", expectedUpdatedAt: updatedAt }),
  ]);
  const updated = statuses.filter(result => result.status === "fulfilled");
  assert.equal(updated.length, 1, "exactly one status update must succeed");
  assert.equal(statuses.filter(result => result.status === "rejected").length, 1);
  const { tasks: records } = await tasks.listTaskRecords(serverId, workspaceId);
  assert.equal(records[0].status, updated[0].value.status);
  assert.equal(existsSync(join(folder, ".mission-control-write.lock")), false);
});

test("attaching a worktree adds its workspace, keeps the source, and is idempotent", async t => {
  const runtime = await mkdtemp(join(pluginRoot, ".test-runtime-"));
  const vault = await mkdtemp(join(tmpdir(), "mission-control-vault-"));
  t.after(async () => {
    assert.ok(runtime.startsWith(`${pluginRoot}${sep}`));
    assert.ok(vault.startsWith(`${tmpdir()}${sep}`));
    await rm(runtime, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  });
  const serverId = "srv_test";
  const taskId = `task_${randomUUID()}`;
  const folder = join(vault, "Tasks", taskId);
  await mkdir(folder, { recursive: true });
  await writeFile(join(vault, "host.json"), JSON.stringify({ schemaVersion: 1, hostId: "personal", serverId }));
  await writeFile(join(folder, "task.md"), taskMarkdown({
    schemaVersion: 1, taskId, hostId: "personal", projectId: "prj_test",
    title: "Worktree fixture", acceptanceCriteria: "Runs in its own worktree.",
    status: "ready", source: "manual", assignments: [{ serverId, workspaceId: "wks_source" }],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  const tasks = await compileFixture(runtime, vault);
  const worktree = { workspaceId: "wks_worktree", branch: "task/abc-worktree-fixture", baseCommit: "a".repeat(40), sourceWorkspaceId: "wks_source", createdAt: "2026-01-02T00:00:00.000Z" };
  const attached = await tasks.attachTaskWorktree({ serverId, taskId, worktree });
  assert.deepEqual(attached.assignments, [{ serverId, workspaceId: "wks_source" }, { serverId, workspaceId: "wks_worktree" }]);
  assert.deepEqual(attached.worktree, worktree);
  assert.equal((await tasks.attachTaskWorktree({ serverId, taskId, worktree })).updatedAt, attached.updatedAt, "re-attaching the same worktree changes nothing");
  await assert.rejects(tasks.attachTaskWorktree({ serverId, taskId, worktree: { ...worktree, workspaceId: "wks_other" } }), /another worktree/);
  // Both workspaces list the task; the Markdown body is untouched.
  assert.equal((await tasks.listTaskRecords(serverId, "wks_source")).tasks.length, 1);
  assert.equal((await tasks.listTaskRecords(serverId, "wks_worktree")).tasks.length, 1);
  assert.match(await readFile(join(folder, "task.md"), "utf8"), /# Concurrent writer fixture\n$/);
});
