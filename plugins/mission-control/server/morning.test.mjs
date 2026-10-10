import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
require.extensions[".ts"] = (module, file) => module._compile(compile(readFileSync(file, "utf8")), file);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(pluginRoot, "..", "..", "scripts", "morning-check.mjs");
const { createMorningStore } = require("./morning.ts");
const { ticketIdentity } = require("../shared/tickets.ts");
const { createWorkflowInstructionsStore } = require("./workflow-instructions-store.mjs");
const serverId = "srv_test";
const record = fields => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n# Record\n`;

// The real task store, pointed at a temporary vault.
async function taskStore(t, vault) {
  const runtime = await mkdtemp(join(pluginRoot, ".test-runtime-"));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  await mkdir(join(runtime, "server")); await mkdir(join(runtime, "shared"));
  await writeFile(join(runtime, "package.json"), '{"type":"commonjs"}');
  for (const name of ["shared/tasks", "shared/task-summary", "server/retrying-rename", "server/tasks"]) {
    const original = await readFile(join(pluginRoot, `${name}.ts`), "utf8");
    const source = name === "server/tasks" ? original.replace(/^const vaultRoot = .*;$/m, `const vaultRoot = ${JSON.stringify(vault)};`) : original;
    if (name === "server/tasks") assert.notEqual(source, original, "fixture must redirect the vault root");
    await writeFile(join(runtime, `${name}.js`), compile(source));
  }
  return require(join(runtime, "server", "tasks.js"));
}

async function fixture(t) {
  const vault = await mkdtemp(join(tmpdir(), "mission-morning-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  await mkdir(join(vault, "Tasks"));
  await writeFile(join(vault, "host.json"), JSON.stringify({ schemaVersion: 1, hostId: "personal", serverId }));
  const kit = join(vault, "kit");
  await mkdir(join(kit, "skills", "morning-check"), { recursive: true }); await mkdir(join(kit, "scripts"));
  await writeFile(join(kit, "skills", "morning-check", "SKILL.md"), "# Morning check\n");
  await writeFile(join(kit, "scripts", "morning-check.mjs"), "");
  const tasks = await taskStore(t, vault);
  const store = createMorningStore({ vaultRoot: vault, sources: tasks.scanTaskSources, createTask: tasks.createTaskRecord, kitRoot: async projectId => projectId === "prj_test" ? kit : null });
  const state = { creates: [], agents: new Map(), failCreate: false, createDelay: 0 };
  const paseo = {
    workspaces: { ref: id => ({
      refresh: async () => ({ wks_test: { id, projectId: "prj_test", archivingAt: null }, wks_bare: { id, projectId: "prj_other", archivingAt: null } })[id] ?? null,
      agents: { create: async options => {
        if (state.createDelay) await new Promise(resolve => setTimeout(resolve, state.createDelay));
        if (state.failCreate) throw new Error("provider offline");
        state.creates.push({ workspaceId: id, ...options });
        state.agents.set(options.agentId, { id: options.agentId, title: options.title, status: "running", activeTurn: { id: "turn" }, pendingPermissions: [], archivedAt: null });
        return { id: options.agentId };
      } },
    }) },
    agents: { ref: id => ({ refresh: async () => {
      if (!state.agents.has(id)) throw new Error(`Agent not found: ${id}`);
      return { agent: state.agents.get(id) };
    } }) },
  };
  const runReport = (...args) => {
    const result = spawnSync(process.execPath, [cli, "report", "--server", serverId, ...args], { encoding: "utf8", env: { ...process.env, DEV_VAULT_ROOT: vault } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { vault, kit, tasks, store, state, paseo, runReport };
}

test("fixture report, import and a second report agree end to end", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.status({ serverId }, f.paseo), { report: null, reportError: null, missing: [], imported: [], launch: null, agent: null });

  const first = f.runReport("--tracker", "fixture");
  let status = await f.store.status({ serverId }, f.paseo);
  assert.equal(status.report.reportId, first.reportId);
  assert.equal(status.report.tracker.mode, "fixture");
  assert.match(status.report.body, /## Not in Mission Control \(3\)/);
  assert.equal(status.missing.length, 3);
  assert.deepEqual(status.imported, []);

  const [jira, , devops] = status.missing;
  const result = await f.store.importItems({ serverId, workspaceId: "wks_test", reportId: first.reportId, items: [ticketIdentity(jira), ticketIdentity(devops), ticketIdentity(jira)] }, f.paseo);
  assert.deepEqual(result.created.map(entry => [entry.key, entry.status]), [[jira.key, "inbox"], [devops.key, "inbox"]]);
  assert.deepEqual(result.skipped, []);

  const created = (await f.tasks.taskSources(serverId)).map(source => source.task);
  const imported = created.find(task => task.ticket?.key === jira.key);
  // The fixture's work item type is kept, so branch names can use {type}.
  assert.deepEqual(imported.ticket, { system: "jira", key: jira.key, url: jira.url, type: "Story" });
  assert.equal(imported.title, `${jira.key} · ${jira.title}`);
  assert.equal(imported.projectId, "prj_test");
  assert.deepEqual(imported.assignments, [{ serverId, workspaceId: "wks_test" }]);
  assert.match(imported.acceptanceCriteria, new RegExp(`^- The task details show the ticket key\\.[\\s\\S]*Imported from Jira ${jira.key}: ${jira.url.replaceAll(".", "\\.")}$`));
  const markdown = await readFile(join(f.vault, "Tasks", imported.taskId, "task.md"), "utf8");
  assert.ok(markdown.split("\n").includes(`ticket: ${JSON.stringify(imported.ticket)}`), "task.md stores the ticket as one frontmatter line");

  status = await f.store.status({ serverId }, f.paseo);
  assert.deepEqual(status.missing.map(item => item.key), ["MCFX-102"]);
  assert.deepEqual(status.imported.map(({ item, tasks }) => [item.key, tasks.map(task => task.taskId)]), [[jira.key, [imported.taskId]], [devops.key, [created.find(task => task.ticket?.key === devops.key).taskId]]]);

  const again = await f.store.importItems({ serverId, workspaceId: "wks_test", reportId: first.reportId, items: [ticketIdentity(jira)] }, f.paseo);
  assert.deepEqual(again, { created: [], skipped: [{ key: jira.key, taskIds: [imported.taskId] }] });
  assert.equal((await f.tasks.taskSources(serverId)).length, 2, "importing twice creates no duplicate");

  const second = f.runReport("--tracker", "fixture");
  const text = await readFile(second.file, "utf8");
  assert.equal(second.review.missing, 1);
  assert.equal(second.review.imported, 2);
  assert.match(text, /## Already in Mission Control \(2\)/);
  status = await f.store.status({ serverId }, f.paseo);
  assert.equal(status.report.reportId, second.reportId, "the newest report is shown");
});

test("an imported task whose file became invalid still counts as imported, so importing never duplicates it", async t => {
  const f = await fixture(t);
  const { reportId } = f.runReport("--tracker", "fixture");
  const [jira, , devops] = (await f.store.status({ serverId }, f.paseo)).missing;
  await f.store.importItems({ serverId, workspaceId: "wks_test", reportId, items: [ticketIdentity(jira), ticketIdentity(devops)] }, f.paseo);
  const [jiraTask, devopsTask] = [jira, devops].map(item => f.tasks.taskSources(serverId).then(sources => sources.find(source => source.task.ticket?.key === item.key)));
  const jiraFile = join(f.vault, "Tasks", (await jiraTask).task.taskId, "task.md");
  const devopsFile = join(f.vault, "Tasks", (await devopsTask).task.taskId, "task.md");

  // Criteria over the 4,000-character limit: the file is skipped, but its ticket line still reads.
  const text = await readFile(jiraFile, "utf8");
  await writeFile(jiraFile, text.replace(/^acceptanceCriteria: .*$/m, `acceptanceCriteria: ${JSON.stringify("x".repeat(4001))}`));
  // A broken ticket line: the "Imported from Azure DevOps <key>:" line in the criteria still names it.
  const devopsText = await readFile(devopsFile, "utf8");
  await writeFile(devopsFile, devopsText.replace(/^ticket: .*$/m, "ticket: {broken"));
  assert.deepEqual((await f.tasks.taskSources(serverId)).length, 0, "both files are invalid now");

  const status = await f.store.status({ serverId }, f.paseo);
  assert.deepEqual(status.missing.map(item => item.key), ["MCFX-102"]);
  const shown = Object.fromEntries(status.imported.map(({ item, tasks }) => [item.key, tasks.map(task => task.status)]));
  assert.deepEqual(shown, { [jira.key]: ["invalid"], [devops.key]: ["invalid"] });
  assert.match(status.imported[0].tasks[0].title, /· Tasks\/task_[a-f0-9-]+\/task\.md$/);

  const again = await f.store.importItems({ serverId, workspaceId: "wks_test", reportId, items: [ticketIdentity(jira), ticketIdentity(devops)] }, f.paseo);
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.skipped.map(entry => entry.key), [jira.key, devops.key]);
  assert.equal((await readdir(join(f.vault, "Tasks"))).filter(name => name.startsWith("task_")).length, 2, "no duplicate task was created");

  // A skipped file that clearly has a ticket nobody can read could be any item: the import refuses and names it.
  await writeFile(devopsFile, record({ schemaVersion: 1, title: "Mystery" }).replace("---\n\n", "ticket: {broken\n---\n\n"));
  await assert.rejects(f.store.importItems({ serverId, workspaceId: "wks_test", reportId, items: ["jira:MCFX-102"] }, f.paseo), /Tasks\/task_[a-f0-9-]+\/task\.md is invalid and its ticket can't be read, so importing could create a duplicate/);
  assert.equal((await readdir(join(f.vault, "Tasks"))).filter(name => name.startsWith("task_")).length, 2);
});

test("import refuses items outside the report, other hosts and unknown workspaces", async t => {
  const f = await fixture(t);
  const { reportId } = f.runReport("--tracker", "fixture");
  await assert.rejects(f.store.importItems({ serverId, workspaceId: "wks_test", reportId, items: ["jira:NOPE-1"] }, f.paseo), /not in this report/);
  await assert.rejects(f.store.importItems({ serverId: "srv_other", workspaceId: "wks_test", reportId, items: ["jira:MCFX-101"] }, f.paseo), /Open Mission Control on that host/);
  await assert.rejects(f.store.importItems({ serverId, workspaceId: "wks_gone", reportId, items: ["jira:MCFX-101"] }, f.paseo), /workspace is unavailable/);
  await assert.rejects(f.store.importItems({ serverId, workspaceId: "wks_test", reportId: "morning-2026-01-01-000000", items: ["jira:MCFX-101"] }, f.paseo), { code: "ENOENT" });
  await writeFile(join(f.vault, "Daily", ".morning-import.lock"), "");
  await assert.rejects(f.store.importItems({ serverId, workspaceId: "wks_test", reportId, items: ["jira:MCFX-101"] }, f.paseo), /Another import is running/);
  assert.deepEqual(await f.tasks.taskSources(serverId), []);
});

test("the newest report wins, including a same-second repeat, and a broken one is reported", async t => {
  const f = await fixture(t);
  await mkdir(join(f.vault, "Daily"));
  const report = reportId => record({ schemaVersion: 1, reportId, hostId: "personal", serverId, agentId: null, createdAt: "2026-09-26T07:00:00Z", since: "2026-09-25T07:00:00Z", tracker: { mode: "unavailable", systems: [] }, items: [], review: { missing: 0, imported: 0, handoffs: 0, openDecisions: 0, blocked: 0, idle: 0, unreadable: 0 } });
  for (const id of ["morning-2026-09-25-070000", "morning-2026-09-26-070000", "morning-2026-09-26-070000-2"]) await writeFile(join(f.vault, "Daily", `${id}.md`), report(id));
  await writeFile(join(f.vault, "Daily", "notes.md"), "Not a report.");
  assert.equal((await f.store.status({ serverId }, f.paseo)).report.reportId, "morning-2026-09-26-070000-2");
  await writeFile(join(f.vault, "Daily", "morning-2026-09-27-070000.md"), report("morning-2026-09-26-070000"));
  const status = await f.store.status({ serverId }, f.paseo);
  assert.equal(status.report, null);
  assert.match(status.reportError, /morning-2026-09-27-070000\.md: .*different report ID/);
});

test("Morning check uses effective Intake guidance while preserving read-only behavior", async t => {
  const f = await fixture(t);
  const instructions = createWorkflowInstructionsStore(f.vault);
  let snapshot = await instructions.read({ serverId, projectId: null });
  await instructions.save({ serverId, projectId: null, expectedRevision: snapshot.revision, values: { intake: "Read the configured Jira project.", planning: "Planning-only text." } });
  snapshot = await instructions.read({ serverId, projectId: "prj_test" });
  await instructions.save({ serverId, projectId: "prj_test", expectedRevision: snapshot.revision, values: { intake: "Also consult Confluence.", planning: "", intakeMode: "append", planningMode: "inherit" } });
  await f.store.start({ serverId, workspaceId: "wks_test", provider: "codex/model", fixture: false }, f.paseo);
  const prompt = f.state.creates[0].prompt;
  assert.match(prompt, /Read the configured Jira project\./);
  assert.match(prompt, /Also consult Confluence\./);
  assert.ok(!prompt.includes("Planning-only text."));
  assert.match(prompt, /Read only: never create, edit, transition/);
});

test("malformed workflow notes prevent Morning check dispatch before creating an agent", async t => {
  const f = await fixture(t);
  await mkdir(join(f.vault, "Workflow"));
  await writeFile(join(f.vault, "Workflow", "host.md"), "broken");
  await assert.rejects(f.store.start({ serverId, workspaceId: "wks_test", provider: "codex/model", fixture: false }, f.paseo), /invalid frontmatter/);
  assert.equal(f.state.creates.length, 0);
});

test("Run Morning check starts one agent with the skill and refuses while it works", async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.start({ serverId: "srv_other", workspaceId: "wks_test", provider: "claude/opus", fixture: true }, f.paseo), /Open Mission Control on that host/);
  await assert.rejects(f.store.start({ serverId, workspaceId: "wks_bare", provider: "claude/opus", fixture: true }, f.paseo), /no Development Flow profile/);

  const status = await f.store.start({ serverId, workspaceId: "wks_test", provider: "claude/opus", thinkingOptionId: "high", fixture: true }, f.paseo);
  assert.equal(f.state.creates.length, 1);
  const [create] = f.state.creates;
  assert.equal(create.workspaceId, "wks_test");
  assert.equal(create.title, "Morning check");
  assert.deepEqual(create.labels, { "mission-control.role": "morning-check" });
  assert.deepEqual(create.config, { provider: "claude/opus", thinkingOptionId: "high" });
  assert.equal(create.idempotencyKey, status.launch.launchId);
  assert.ok(create.prompt.includes(join(f.kit, "skills", "morning-check", "SKILL.md")));
  assert.match(create.prompt, /--tracker fixture/);
  assert.match(create.prompt, /Read only: never create, edit/);
  assert.ok(create.prompt.includes(`agent ID is ${create.agentId}`));
  assert.deepEqual([status.launch.phase, status.launch.fixture, status.launch.error, status.agent.busy], ["sent", true, null, true]);

  await assert.rejects(f.store.start({ serverId, workspaceId: "wks_test", provider: "claude/opus", fixture: false }, f.paseo), /still running/);
  f.state.agents.get(create.agentId).status = "idle";
  f.state.agents.get(create.agentId).activeTurn = null;
  await f.store.start({ serverId, workspaceId: "wks_test", provider: "codex/gpt", fixture: false }, f.paseo);
  assert.match(f.state.creates[1].prompt, /Jira or Azure DevOps MCP tools this session has.*--tracker unavailable/s);

  f.state.agents.clear();
  f.state.failCreate = true;
  await assert.rejects(f.store.start({ serverId, workspaceId: "wks_test", provider: "codex/gpt", fixture: false }, f.paseo), /provider offline/);
  const failed = JSON.parse(await readFile(join(f.vault, "Daily", ".morning-check-launch.json"), "utf8"));
  assert.deepEqual([failed.phase, failed.error], ["sending", "provider offline"]);

  await rm(join(f.kit, "skills"), { recursive: true });
  f.state.failCreate = false;
  await assert.rejects(f.store.start({ serverId, workspaceId: "wks_test", provider: "codex/gpt", fixture: false }, f.paseo), /has no Morning check yet/);
  assert.equal(f.state.creates.length, 2);
  assert.deepEqual((await readdir(join(f.vault, "Daily"))).filter(name => name.endsWith(".tmp") || name.endsWith(".lock")), []);
});

test("a Morning check agent that errored or closed doesn't block the next one; a working one does", async t => {
  const f = await fixture(t);
  const start = () => f.store.start({ serverId, workspaceId: "wks_test", provider: "claude/opus", fixture: true }, f.paseo);
  const latest = () => f.state.agents.get(f.state.creates.at(-1).agentId);
  await start();
  for (const ended of ["error", "closed"]) {
    Object.assign(latest(), { status: ended, activeTurn: null });
    const status = await f.store.status({ serverId }, f.paseo);
    assert.deepEqual([status.agent.status, status.agent.busy], [ended, false], `${ended} agent reads as finished`);
    await start();
  }
  assert.equal(f.state.creates.length, 3);
  for (const working of [{ status: "initializing", activeTurn: null }, { status: "idle", activeTurn: null, pendingPermissions: [{ id: "permission" }] }, { status: "idle", activeTurn: { id: "turn" } }]) {
    Object.assign(latest(), { pendingPermissions: [], ...working });
    assert.equal((await f.store.status({ serverId }, f.paseo)).agent.busy, true, JSON.stringify(working));
    await assert.rejects(start(), /still running/);
  }
  assert.equal(f.state.creates.length, 3);
});

test("overlapping Morning check starts create one agent", async t => {
  const f = await fixture(t);
  f.state.createDelay = 100;
  const start = () => f.store.start({ serverId, workspaceId: "wks_test", provider: "claude/opus", fixture: true }, f.paseo);
  const results = await Promise.allSettled([start(), start(), start()]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  for (const result of results.filter(result => result.status === "rejected")) assert.match(result.reason.message, /is starting|still running/);
  assert.equal(f.state.creates.length, 1);
  const launch = JSON.parse(await readFile(join(f.vault, "Daily", ".morning-check-launch.json"), "utf8"));
  assert.equal(launch.agentId, f.state.creates[0].agentId, "the journal tracks the one agent that started");
  assert.deepEqual((await readdir(join(f.vault, "Daily"))).filter(name => name.endsWith(".lock")), [], "the start lock is released");
  await assert.rejects(start(), /still running/);
  await writeFile(join(f.vault, "Daily", ".morning-start.lock"), "");
  Object.assign(f.state.agents.get(launch.agentId), { status: "idle", activeTurn: null });
  await assert.rejects(start(), /is starting/);
  assert.equal(f.state.creates.length, 1);
});
