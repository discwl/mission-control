#!/usr/bin/env node
// Writes the Morning check report for this host's vault. The morning-check skill collects the
// user's current-sprint items from Jira or Azure DevOps; this script compares them with the vault's
// tasks and reviews the previous day's work. It reads tracker data only from the items file.
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const vaultPath = process.env.DEV_VAULT_ROOT || "C:\\dev-vault";
const fixtureItems = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "morning-check-items.json");
const taskIdPattern = /^task_[a-f0-9-]+$/;
const runIdPattern = /^run_[a-f0-9-]+$/;
const systems = new Set(["jira", "azure-devops"]);
const systemLabels = { jira: "Jira", "azure-devops": "Azure DevOps" };
const trackerModes = new Set(["read", "unavailable", "fixture"]);
const idleHours = 24;

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith("--") || !argv[index + 1]) throw new Error(`Expected --name value, got ${flag || "end of input"}.`);
    result[flag.slice(2)] = argv[index + 1];
  }
  return result;
}

function within(root, candidate) {
  const remainder = relative(root, candidate);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith("..\\") && !remainder.startsWith("../") && !isAbsolute(remainder));
}

function parseRecord(markdown, label) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!frontmatter) throw new Error(`${label} has no JSON-value frontmatter.`);
  const fields = {};
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`${label} has invalid frontmatter.`);
    const key = line.slice(0, separator);
    if (Object.hasOwn(fields, key)) throw new Error(`${label} repeats ${key}.`);
    fields[key] = JSON.parse(line.slice(separator + 1).trim());
  }
  return fields;
}

// Same identity as ticketIdentity in plugins/mission-control/shared/tickets.ts.
function ticketIdentity(ticket) {
  return `${ticket.system}:${ticket.key.trim().toUpperCase()}`;
}

/** Splits items into those no task carries yet and those already imported, keeping item order. */
function compareTrackerItems(items, tasks) {
  const taskIds = new Map();
  for (const task of tasks) {
    if (!task.ticket || !systems.has(task.ticket.system) || typeof task.ticket.key !== "string") continue;
    const identity = ticketIdentity(task.ticket);
    taskIds.set(identity, [...taskIds.get(identity) ?? [], task.taskId]);
  }
  const seen = new Set();
  const result = { missing: [], imported: [] };
  for (const item of items) {
    const identity = ticketIdentity(item);
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (taskIds.has(identity)) result.imported.push({ item, taskIds: taskIds.get(identity) });
    else result.missing.push(item);
  }
  return result;
}

function text(value, label, max, required = false) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string" || value.length > max) throw new Error(`${label} must be text of at most ${max} characters.`);
  if (required && !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

// Keep in step with trackerItemSchema in plugins/mission-control/shared/tickets.ts.
function checkItems(parsed) {
  const list = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(list) || list.length > 200) throw new Error("Items must be a JSON array (or { \"items\": [...] }) of at most 200 work items.");
  return list.map((item, index) => {
    const label = `Item ${index + 1}`;
    if (!item || typeof item !== "object") throw new Error(`${label} must be an object.`);
    if (!systems.has(item.system)) throw new Error(`${label} needs system "jira" or "azure-devops".`);
    const key = text(String(item.key ?? ""), `${label} key`, 100, true);
    if (/[\r\n]/.test(key)) throw new Error(`${label} key must be one line.`);
    const url = text(item.url, `${label} url`, 2000, true);
    if (!/^https?:\/\/\S+$/i.test(url)) throw new Error(`${label} url must be an http(s) link.`);
    const type = text(item.type, `${label} type`, 100);
    if (/[\r\n]/.test(type)) throw new Error(`${label} type must be one line.`);
    return {
      system: item.system, key, url, ...(type ? { type } : {}),
      title: text(item.title, `${label} title`, 300, true),
      description: text(item.description, `${label} description`, 20_000),
      acceptanceCriteria: text(item.acceptanceCriteria, `${label} acceptanceCriteria`, 20_000),
      status: text(item.status, `${label} status`, 100),
      sprint: text(item.sprint, `${label} sprint`, 200),
    };
  });
}

async function optionalFile(file) {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function folderNames(folder, pattern) {
  try { return (await readdir(folder)).filter(name => pattern.test(name)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

// Reads every task with its latest run, recent handoffs and open decisions. A record that can't be
// read becomes a warning in the report instead of stopping the check.
async function readVault(root) {
  const tasksRoot = await realpath(join(root, "Tasks"));
  if (!within(root, tasksRoot)) throw new Error("Tasks folder escapes the vault.");
  const tasks = [];
  const warnings = [];
  for (const name of await readdir(tasksRoot)) {
    const folderName = taskIdPattern.test(name);
    if (!folderName && !/^task_[a-f0-9-]+\.md$/.test(name)) continue;
    try {
      const folder = folderName ? join(tasksRoot, name) : null;
      const kind = await lstat(join(tasksRoot, name));
      if (kind.isSymbolicLink() || (folder ? !kind.isDirectory() : !kind.isFile())) throw new Error("not a regular task entry");
      const task = parseRecord(await readFile(folder ? join(folder, "task.md") : join(tasksRoot, name), "utf8"), "Task");
      if (task.taskId !== (folder ? name : name.slice(0, -3))) throw new Error("task ID does not match its path");
      const entry = { task, runs: [], handoffs: [], decisions: [] };
      for (const runName of folder ? await folderNames(join(folder, "runs"), runIdPattern) : []) {
        const runFolder = join(folder, "runs", runName);
        const run = parseRecord(await readFile(join(runFolder, "run.md"), "utf8"), "Run");
        entry.runs.push(run);
        const handoff = await optionalFile(join(runFolder, "handoff.md"));
        if (handoff) entry.handoffs.push({ ...parseRecord(handoff, "Handoff"), runId: runName, body: handoff.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "") });
        for (const decisionName of await folderNames(join(runFolder, "decisions"), /^decision_[a-f0-9-]+\.md$/)) {
          const decision = parseRecord(await readFile(join(runFolder, "decisions", decisionName), "utf8"), "Decision");
          if (decision.status === "open") entry.decisions.push(decision);
        }
      }
      entry.runs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      tasks.push(entry);
    } catch (error) {
      warnings.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { tasks, warnings };
}

// Text for Markdown link labels and wiki links, which break on brackets, pipes and newlines.
function label(value) {
  return String(value).replace(/[\r\n]+/g, " ").replace(/[[\]|]/g, "").trim() || "Untitled";
}
function taskLink(task) {
  return `[[Tasks/${task.taskId}/task|${label(task.title)}]]`;
}
function itemLink(item) {
  return `[${label(item.key)}](${item.url}) ${label(item.title)}`;
}
function sectionOf(title, lines, empty) {
  return `## ${title} (${lines.length})\n\n${lines.length ? lines.join("\n") : empty}`;
}
function firstLine(value, max = 240) {
  const line = String(value ?? "").split(/\r?\n/).map(part => part.trim()).find(part => part && !part.startsWith("#")) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
function pad(value, size = 2) { return String(value).padStart(size, "0"); }
function localDate(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
function localStamp(date) { return `${localDate(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`; }

/** Builds the report fields and Markdown body. Pure apart from the given clock. */
function buildReport({ host, vault, items, tracker, notes, since, now, agentId }) {
  const openTasks = vault.tasks.filter(entry => !["delivered", "closed"].includes(entry.task.status));
  const comparison = compareTrackerItems(items, vault.tasks.map(entry => entry.task));
  const titles = new Map(vault.tasks.map(entry => [entry.task.taskId, entry.task]));
  const handoffs = vault.tasks.flatMap(entry => entry.handoffs
    .filter(handoff => typeof handoff.at === "string" && Date.parse(handoff.at) >= since.getTime())
    .map(handoff => ({ task: entry.task, handoff, run: entry.runs.find(run => run.runId === handoff.runId) })))
    .sort((a, b) => b.handoff.at.localeCompare(a.handoff.at));
  const decisions = vault.tasks.flatMap(entry => entry.decisions.map(decision => ({ task: entry.task, decision })))
    .sort((a, b) => String(a.decision.requestedAt).localeCompare(String(b.decision.requestedAt)));
  const blocked = openTasks.filter(entry => entry.task.status === "blocked" || entry.runs[0]?.outcome === "blocked");
  const waiting = new Set(decisions.map(entry => entry.task.taskId));
  const idleBefore = now.getTime() - idleHours * 3_600_000;
  const idle = openTasks.filter(entry => {
    if (entry.task.status !== "in_progress" || blocked.includes(entry) || waiting.has(entry.task.taskId)) return false;
    const activity = Math.max(Date.parse(entry.task.updatedAt) || 0, Date.parse(entry.runs[0]?.updatedAt ?? "") || 0);
    return activity < idleBefore;
  });

  const trackerLine = tracker.mode === "unavailable"
    ? "No Jira or Azure DevOps tools were available in this session, so current-sprint items were not read."
    : `${tracker.mode === "fixture" ? "Test fixture (not a live tracker)" : `Read from ${tracker.systems.map(system => systemLabels[system]).join(" and ") || "the tracker"}`} · ${items.length} current-sprint ${items.length === 1 ? "item" : "items"}.`;
  const itemLine = item => `- [ ] ${itemLink(item)} · ${systemLabels[item.system]}${item.status ? ` · ${label(item.status)}` : ""}${item.sprint ? ` · ${label(item.sprint)}` : ""}`;
  const body = [
    `# Morning check · ${label(host.hostId)} · ${localDate(now)}`,
    `Covers work since ${since.toISOString()}. Written ${now.toISOString()}.`,
    `## Tracker\n\n${trackerLine}`,
    tracker.mode === "unavailable" ? null : sectionOf("Not in Mission Control", comparison.missing.map(itemLine), "Every current-sprint item already has a task."),
    tracker.mode === "unavailable" ? null : sectionOf("Already in Mission Control", comparison.imported.map(({ item, taskIds }) =>
      `- ${itemLink(item)} → ${taskIds.map(id => titles.has(id) ? `${taskLink(titles.get(id))} (${titles.get(id).status.replaceAll("_", " ")})` : id).join(", ")}`), "None yet."),
    sectionOf("Yesterday's handoffs", handoffs.map(({ task, handoff, run }) => {
      const summary = firstLine(handoff.body);
      return `- ${taskLink(task)} · ${handoff.at}${run ? ` · ${run.stage} ${String(run.outcome).replaceAll("_", " ")}` : ""} · [[Tasks/${task.taskId}/runs/${handoff.runId}/handoff|handoff]]${summary ? `\n  - ${summary}` : ""}`;
    }), "No handoffs since then."),
    sectionOf("Needs you", decisions.map(({ task, decision }) =>
      `- ${taskLink(task)} · ${decision.kind} decision · ${label(decision.question)} · requested ${decision.requestedAt}`), "No open decisions."),
    sectionOf("Blocked", blocked.map(({ task, runs }) =>
      `- ${taskLink(task)} · task ${task.status.replaceAll("_", " ")}${runs[0] ? ` · run ${runs[0].stage} ${String(runs[0].outcome).replaceAll("_", " ")} · next: ${label(runs[0].nextAction)}` : ""}`), "Nothing blocked."),
    sectionOf("Idle", idle.map(({ task, runs }) =>
      `- ${taskLink(task)} · in progress · ${runs[0] ? `last run activity ${runs[0].updatedAt}` : `no run; task updated ${task.updatedAt}`}`), `No in-progress task has been quiet for ${idleHours} hours.`),
    notes.trim() ? `## Agent notes\n\n${notes.trim()}` : null,
    vault.warnings.length ? `## Records that could not be read (${vault.warnings.length})\n\n${vault.warnings.map(warning => `- ${label(warning)}`).join("\n")}` : null,
  ].filter(Boolean).join("\n\n");

  const reportId = `morning-${localStamp(now)}`;
  const fields = {
    schemaVersion: 1, reportId, hostId: host.hostId, serverId: host.serverId, agentId: agentId ?? null,
    createdAt: now.toISOString(), since: since.toISOString(),
    tracker: { mode: tracker.mode, systems: tracker.systems },
    items: items.map(item => ({ ...item, taskIds: comparison.imported.find(entry => entry.item === item)?.taskIds ?? [] })),
    review: { missing: comparison.missing.length, imported: comparison.imported.length, handoffs: handoffs.length, openDecisions: decisions.length, blocked: blocked.length, idle: idle.length, unreadable: vault.warnings.length },
  };
  return { fields, body };
}

function markdownRecord(fields, body) {
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n${body.trim()}\n`;
}

async function report(args) {
  const root = await realpath(vaultPath);
  const host = JSON.parse(await readFile(join(root, "host.json"), "utf8"));
  if (host.schemaVersion !== 1 || !args.server || host.serverId !== args.server) throw new Error("--server must match this vault's host.json serverId.");
  const mode = args.tracker ?? (args.items ? "read" : "unavailable");
  if (!trackerModes.has(mode)) throw new Error("--tracker must be read, unavailable or fixture.");
  if (mode === "unavailable" && args.items) throw new Error("Don't pass --items with --tracker unavailable.");
  if (mode === "read" && !args.items) throw new Error("--tracker read needs --items with the items you read.");
  const itemsFile = mode === "fixture" ? args.items ?? fixtureItems : args.items;
  // Overlapping queries can return an item twice; the report keeps its first row.
  const items = [];
  const seen = new Set();
  for (const item of itemsFile ? checkItems(JSON.parse(await readFile(itemsFile, "utf8"))) : []) {
    if (!seen.has(ticketIdentity(item))) { seen.add(ticketIdentity(item)); items.push(item); }
  }
  const notes = args.notes ? await readFile(args.notes, "utf8") : "";
  if (notes.length > 20_000) throw new Error("Notes are too long.");
  const now = new Date();
  const since = args.since ? new Date(args.since) : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (Number.isNaN(since.getTime()) || since > now) throw new Error("--since must be a past date and time.");
  if (args.agent && !/^[a-zA-Z0-9_-]{1,128}$/.test(args.agent)) throw new Error("Invalid agent ID.");
  const vault = await readVault(root);
  const { fields, body } = buildReport({
    host, vault, items, notes, since, now, agentId: args.agent || process.env.PASEO_AGENT_ID || null,
    tracker: { mode, systems: [...new Set(items.map(item => item.system))] },
  });
  const daily = join(root, "Daily");
  await mkdir(daily, { recursive: true });
  if (!within(root, await realpath(daily))) throw new Error("Daily folder escapes the vault.");
  // Publish only a complete file, and never replace a report: two checks in the same second get distinct names.
  let reportId = fields.reportId;
  for (let attempt = 2; ; attempt++) {
    const file = join(daily, `${reportId}.md`);
    const temporary = join(daily, `.${reportId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, markdownRecord({ ...fields, reportId }, body), { flag: "wx" });
      await link(temporary, file);
      return { reportId, file, tracker: fields.tracker, review: fields.review };
    } catch (error) {
      if (error.code !== "EEXIST" || attempt > 20) throw error;
      reportId = `${fields.reportId}-${attempt}`;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command !== "report") {
    process.stdout.write("Usage: morning-check.mjs report --server ID [--tracker read|unavailable|fixture] [--items JSON] [--notes FILE] [--since ISO] [--agent ID]\n");
    if (command && command !== "help") process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(await report(options(argv)), null, 2)}\n`);
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
