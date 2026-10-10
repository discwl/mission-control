import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = join(dirname(fileURLToPath(import.meta.url)), "morning-check.mjs");
const serverId = "srv_test";
const hours = count => new Date(Date.now() - count * 3_600_000).toISOString();
const record = (fields, body = "# Record") => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n${body}\n`;

let counter = 0;
function taskId() { counter++; return `task_${String(counter).padStart(8, "0")}-aaaa-4aaa-aaaa-aaaaaaaaaaaa`; }
function runId(id) { return `run_${id.slice(5)}`; }

async function vault(t) {
  const root = await mkdtemp(join(tmpdir(), "morning-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "Tasks"));
  await writeFile(join(root, "host.json"), JSON.stringify({ schemaVersion: 1, hostId: "personal", serverId }));
  return root;
}

async function addTask(root, fields, run) {
  const id = taskId();
  const folder = join(root, "Tasks", id);
  await mkdir(folder);
  const task = { schemaVersion: 1, taskId: id, hostId: "personal", projectId: "prj_test", title: `Task ${counter}`, acceptanceCriteria: "Done.", status: "in_progress", source: "manual", assignments: [{ serverId, workspaceId: "wks_test" }], createdAt: hours(100), updatedAt: hours(1), ...fields };
  await writeFile(join(folder, "task.md"), record(task, `# ${task.title}`));
  if (run) {
    const runFolder = join(folder, "runs", runId(id));
    await mkdir(join(runFolder, "decisions"), { recursive: true });
    await writeFile(join(runFolder, "run.md"), record({ schemaVersion: 1, runId: runId(id), taskId: id, stage: "execute", outcome: "in_progress", updatedAt: hours(1), nextAction: "Keep going.", ...run.run }));
    if (run.handoffAt) await writeFile(join(runFolder, "handoff.md"), record({ schemaVersion: 1, taskId: id, runId: runId(id), at: run.handoffAt }, "# Handoff\n\nBuilt the importer and wrote tests.\n\n## Next action\n\nReview."));
    if (run.decision) await writeFile(join(runFolder, "decisions", "decision_aaaaaaaa-0000-4000-8000-000000000001.md"), record({ schemaVersion: 1, decisionId: "decision_aaaaaaaa-0000-4000-8000-000000000001", kind: "plan", status: run.decision, question: "Approve this plan?", requestedAt: hours(2) }));
  }
  return task;
}

function report(root, args) {
  return spawnSync(process.execPath, [cli, "report", "--server", serverId, ...args], { encoding: "utf8", env: { ...process.env, DEV_VAULT_ROOT: root } });
}

async function readReport(root, file) {
  const text = await readFile(file, "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)[1];
  return { fields: Object.fromEntries(frontmatter.split("\n").map(line => [line.slice(0, line.indexOf(":")), JSON.parse(line.slice(line.indexOf(":") + 1))])), body: text.slice(text.indexOf("\n---\n") + 5) };
}

test("the report separates imported from missing items and reviews the previous day's work", async t => {
  const root = await vault(t);
  const imported = await addTask(root, { ticket: { system: "jira", key: "ABC-1", url: "https://example.atlassian.net/browse/ABC-1" } });
  await addTask(root, { ticket: { system: "azure-devops", key: "77", url: "https://dev.azure.com/o/p/_workitems/edit/77" }, status: "delivered" });
  const handedOff = await addTask(root, {}, { run: { stage: "handoff", outcome: "completed" }, handoffAt: hours(3) });
  await addTask(root, {}, { handoffAt: hours(24 * 5) });
  const blocked = await addTask(root, { status: "blocked" });
  const waiting = await addTask(root, { updatedAt: hours(72) }, { run: { outcome: "waiting", updatedAt: hours(72) }, decision: "open" });
  const idle = await addTask(root, { updatedAt: hours(72) }, { run: { updatedAt: hours(48) } });
  await addTask(root, { status: "closed", updatedAt: hours(72) }, { run: { outcome: "blocked", updatedAt: hours(72) }, decision: "approved" });
  await writeFile(join(root, "Tasks", "task_bbbbbbbb-0000-4000-8000-000000000000"), "not a folder");
  const items = join(root, "items.json");
  await writeFile(items, JSON.stringify({ items: [
    { system: "jira", key: "abc-1", url: "https://example.atlassian.net/browse/ABC-1", title: "Already imported, different case" },
    { system: "jira", key: "ABC-2", url: "https://example.atlassian.net/browse/ABC-2", title: "Not imported | yet [draft]", status: "To Do", sprint: "Sprint 9" },
    { system: "jira", key: "ABC-2", url: "https://example.atlassian.net/browse/ABC-2", title: "Duplicate row from a second query" },
    { system: "azure-devops", key: 77, url: "https://dev.azure.com/o/p/_workitems/edit/77", title: "Imported, delivered task still counts" },
    { system: "jira", key: "77", url: "https://example.atlassian.net/browse/77", title: "Same key, other system" },
  ] }));
  const notes = join(root, "notes.md");
  await writeFile(notes, "Used searchJiraIssuesUsingJql.");

  const result = report(root, ["--tracker", "read", "--items", items, "--notes", notes, "--since", hours(24), "--agent", "agent-1"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.reportId, /^morning-\d{4}-\d{2}-\d{2}-\d{6}$/);
  assert.deepEqual(output.review, { missing: 2, imported: 2, handoffs: 1, openDecisions: 1, blocked: 1, idle: 1, unreadable: 1 });
  assert.deepEqual(await readdir(join(root, "Daily")), [`${output.reportId}.md`]);

  const { fields, body } = await readReport(root, output.file);
  assert.equal(fields.reportId, output.reportId);
  assert.equal(fields.serverId, serverId);
  assert.equal(fields.agentId, "agent-1");
  assert.deepEqual(fields.tracker, { mode: "read", systems: ["jira", "azure-devops"] });
  assert.deepEqual(fields.items.map(item => [item.key, item.title, item.taskIds.length]), [["abc-1", "Already imported, different case", 1], ["ABC-2", "Not imported | yet [draft]", 0], ["77", "Imported, delivered task still counts", 1], ["77", "Same key, other system", 0]]);
  assert.equal(fields.items[0].taskIds[0], imported.taskId);

  const section = title => body.split("\n## ").find(part => part.startsWith(title)) ?? "";
  assert.match(section("Not in Mission Control (2)"), /- \[ \] \[ABC-2\]\(https:\/\/example.atlassian.net\/browse\/ABC-2\) Not imported  yet draft · Jira · To Do · Sprint 9/);
  assert.match(section("Not in Mission Control (2)"), /\[77\]\(https:\/\/example.atlassian.net\/browse\/77\)/);
  assert.match(section("Already in Mission Control (2)"), new RegExp(`\\[\\[Tasks/${imported.taskId}/task\\|Task 1\\]\\] \\(in progress\\)`));
  assert.match(section("Yesterday's handoffs (1)"), new RegExp(`${handedOff.taskId}/task\\|Task 3.*handoff completed[\\s\\S]*Built the importer and wrote tests.`));
  assert.match(section("Needs you (1)"), new RegExp(`${waiting.taskId}.*plan decision · Approve this plan\\?`));
  assert.match(section("Blocked (1)"), new RegExp(blocked.taskId));
  assert.match(section("Idle (1)"), new RegExp(`${idle.taskId}.*last run activity`));
  assert.match(section("Agent notes"), /searchJiraIssuesUsingJql/);
  assert.match(section("Records that could not be read (1)"), /task_bbbbbbbb/);
});

test("without tracker tools the report says so and still reviews Mission Control", async t => {
  const root = await vault(t);
  await addTask(root, { status: "blocked" });
  const result = report(root, ["--tracker", "unavailable"]);
  assert.equal(result.status, 0, result.stderr);
  const { fields, body } = await readReport(root, JSON.parse(result.stdout).file);
  assert.deepEqual(fields.tracker, { mode: "unavailable", systems: [] });
  assert.deepEqual(fields.items, []);
  assert.match(body, /No Jira or Azure DevOps tools were available/);
  assert.doesNotMatch(body, /Not in Mission Control/);
  assert.match(body, /## Blocked \(1\)/);
});

test("the fixture needs no tracker and every fixture item starts as missing", async t => {
  const root = await vault(t);
  const result = report(root, ["--tracker", "fixture"]);
  assert.equal(result.status, 0, result.stderr);
  const { fields, body } = await readReport(root, JSON.parse(result.stdout).file);
  assert.equal(fields.tracker.mode, "fixture");
  assert.deepEqual(fields.tracker.systems, ["jira", "azure-devops"]);
  assert.equal(fields.review.missing, fields.items.length);
  assert.ok(fields.items.length >= 2);
  // Work item types reach the report when known, so imports can name feature/ or bugfix/ branches.
  assert.deepEqual(fields.items.map(item => item.type ?? null), ["Story", null, "Bug"]);
  assert.match(body, /Test fixture \(not a live tracker\)/);
});

test("the script refuses another host, bad items, and mismatched tracker options", async t => {
  const root = await vault(t);
  const items = join(root, "items.json");
  assert.match(spawnSync(process.execPath, [cli, "report", "--server", "srv_other", "--tracker", "unavailable"], { encoding: "utf8", env: { ...process.env, DEV_VAULT_ROOT: root } }).stderr, /host\.json serverId/);
  for (const [item, message] of [
    [{ system: "github", key: "1", url: "https://x", title: "t" }, /system/],
    [{ system: "jira", key: "A-1", url: "javascript:alert(1)", title: "t" }, /http\(s\) link/],
    [{ system: "jira", key: "A-1\nB", url: "https://x", title: "t" }, /one line/],
    [{ system: "jira", key: "A-1", url: "https://x", title: "t", type: "Bug\nStory" }, /type must be one line/],
    [{ system: "jira", key: "A-1", url: "https://x", title: " " }, /title is required/],
  ]) {
    await writeFile(items, JSON.stringify([item]));
    const result = report(root, ["--items", items]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
  assert.match(report(root, ["--tracker", "read"]).stderr, /needs --items/);
  assert.match(report(root, ["--tracker", "unavailable", "--items", items]).stderr, /Don't pass --items/);
  assert.match(report(root, ["--tracker", "unavailable", "--since", "2999-01-01T00:00:00Z"]).stderr, /past date/);
  await assert.rejects(readdir(join(root, "Daily")), { code: "ENOENT" });
});
