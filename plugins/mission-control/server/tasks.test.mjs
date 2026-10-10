import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverId = "srv_test";
const workspaceId = "wks_test";
const markdown = fields => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n# Task\n`;
const task = (taskId, overrides = {}) => ({
  schemaVersion: 1, taskId, hostId: "personal", projectId: "prj_test", title: `Task ${taskId.slice(5, 9)}`, acceptanceCriteria: "Works.",
  status: "ready", source: "manual", assignments: [{ serverId, workspaceId }], createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z", ...overrides,
});

// The real task store, compiled into the plugin folder and pointed at a scratch vault.
async function taskStore(t) {
  const runtime = await mkdtemp(join(pluginRoot, ".test-runtime-"));
  const vault = await mkdtemp(join(tmpdir(), "mission-tasks-"));
  t.after(async () => {
    assert.ok(runtime.startsWith(`${pluginRoot}${sep}`));
    await rm(runtime, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  });
  await mkdir(join(runtime, "server"), { recursive: true });
  await mkdir(join(runtime, "shared"), { recursive: true });
  await writeFile(join(runtime, "package.json"), '{"type":"commonjs"}');
  for (const name of ["shared/tasks", "shared/task-summary", "server/retrying-rename", "server/tasks"]) {
    const original = await readFile(join(pluginRoot, `${name}.ts`), "utf8");
    const source = name === "server/tasks" ? original.replace(/^const vaultRoot = .*;$/m, `const vaultRoot = ${JSON.stringify(vault)};`) : original;
    if (name === "server/tasks") assert.notEqual(source, original, "fixture must redirect the vault root");
    await writeFile(join(runtime, `${name}.js`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: `${name}.ts` }).outputText);
  }
  await mkdir(join(vault, "Tasks"));
  await writeFile(join(vault, "host.json"), JSON.stringify({ schemaVersion: 1, hostId: "personal", serverId }));
  return { vault, tasks: require(join(runtime, "server", "tasks.js")), shared: require(join(runtime, "shared", "tasks.js")) };
}

test("an invalid task file is skipped and named, and the other tasks still load", async t => {
  const { vault, tasks, shared } = await taskStore(t);
  const good = "task_11111111-0000-4000-8000-000000000000";
  const long = "task_22222222-0000-4000-8000-000000000000";
  const broken = "task_33333333-0000-4000-8000-000000000000";
  for (const id of [good, long, broken]) await mkdir(join(vault, "Tasks", id));
  await writeFile(join(vault, "Tasks", good, "task.md"), markdown(task(good)));
  // Criteria over the 4,000-character limit, as in the report that made the whole list fail.
  await writeFile(join(vault, "Tasks", long, "task.md"), markdown(task(long, { acceptanceCriteria: "x".repeat(4001) })));
  await writeFile(join(vault, "Tasks", broken, "task.md"), "no frontmatter here\n");

  const { tasks: listed, problems } = await tasks.listTaskRecords(serverId, workspaceId);
  assert.deepEqual(listed.map(item => item.taskId), [good]);
  assert.deepEqual(problems.map(problem => problem.file), [`Tasks/${long}/task.md`, `Tasks/${broken}/task.md`]);
  assert.match(problems[0].problem, /^acceptanceCriteria: .*4000/);
  assert.equal(problems[1].problem, "Task record has no frontmatter.");
  assert.equal(shared.taskProblemLine(problems[0]).startsWith(`Skipped Tasks/${long}/task.md: acceptanceCriteria: `), true);

  // The host's task counts skip it too, and carry the same warning.
  const summary = await tasks.readTaskSummary(serverId);
  assert.deepEqual(summary.counts, { total: 1, active: 1 });
  assert.deepEqual(summary.problems, problems);
  assert.deepEqual((await tasks.taskSources(serverId)).map(source => source.task.taskId), [good]);

  // Opening the invalid task directly names the file and the problem instead of "not assigned".
  await assert.rejects(tasks.listTaskDocumentRecords(serverId, workspaceId, long), new RegExp(`The task file Tasks/${long}/task\\.md is invalid: acceptanceCriteria: `));
});

test("a due date can be set, changed and cleared, and other task writes keep it", async t => {
  const { vault, tasks } = await taskStore(t);
  const id = "task_dddddddd-0000-4000-8000-000000000001";
  await mkdir(join(vault, "Tasks", id));
  await writeFile(join(vault, "Tasks", id, "task.md"), markdown(task(id)));
  const read = async () => (await tasks.listTaskRecords(serverId, workspaceId)).tasks.find(item => item.taskId === id);
  let current = await read();
  assert.equal(current.dueDate, undefined);

  current = await tasks.updateTaskDueDateRecord({ serverId, workspaceId, taskId: id, dueDate: "2026-10-08", expectedUpdatedAt: current.updatedAt });
  assert.equal(current.dueDate, "2026-10-08");
  assert.equal((await read()).dueDate, "2026-10-08");
  await assert.rejects(tasks.updateTaskDueDateRecord({ serverId, workspaceId, taskId: id, dueDate: "2026-10-22", expectedUpdatedAt: "2026-09-26T00:00:00Z" }), /changed since it was loaded/);

  current = await tasks.updateTaskStatusRecord({ serverId, workspaceId, taskId: id, status: "in_progress", expectedUpdatedAt: current.updatedAt });
  assert.equal(current.dueDate, "2026-10-08", "a status change keeps the due date");
  current = await tasks.updateTaskDueDateRecord({ serverId, workspaceId, taskId: id, dueDate: "2026-10-22", expectedUpdatedAt: current.updatedAt });
  assert.equal(current.dueDate, "2026-10-22");
  const file = await readFile(join(vault, "Tasks", id, "task.md"), "utf8");
  assert.equal(file.match(/^dueDate:/gm).length, 1, "changing the date replaces the line");

  current = await tasks.updateTaskDueDateRecord({ serverId, workspaceId, taskId: id, dueDate: null, expectedUpdatedAt: current.updatedAt });
  assert.equal(current.dueDate, undefined);
  assert.doesNotMatch(await readFile(join(vault, "Tasks", id, "task.md"), "utf8"), /^dueDate:/m);
  assert.equal(current.status, "in_progress");
});
