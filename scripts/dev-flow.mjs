#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createWorkflowInstructionsStore } from "../plugins/mission-control/server/workflow-instructions-store.mjs";
import { workflowInstructionsPrompt } from "../plugins/mission-control/shared/workflow-instructions.mjs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { lstat, open, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const vaultPath = process.env.DEV_VAULT_ROOT || "C:\\dev-vault";
const taskIdPattern = /^task_[a-f0-9-]+$/;
const runIdPattern = /^run_[a-f0-9-]+$/;
const stages = new Set(["intake", "plan", "execute", "validate", "review", "fix", "delivery", "handoff"]);
const outcomes = new Set(["in_progress", "completed", "blocked", "waiting"]);

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith("--") || !argv[index + 1]) throw new Error(`Expected --name value, got ${flag || "end of input"}.`);
    result[flag.slice(2)] = argv[index + 1];
  }
  return result;
}

function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value;
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

function markdownRecord(fields, body) {
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n${body.trim()}\n`;
}

async function atomicWrite(file, content) {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function loadTask(taskId) {
  if (!taskIdPattern.test(taskId || "")) throw new Error("Invalid task ID.");
  const root = await realpath(vaultPath);
  const tasks = await realpath(join(root, "Tasks"));
  if (!within(root, tasks)) throw new Error("Tasks folder escapes the vault.");
  const folder = await realpath(join(tasks, taskId));
  if (!within(tasks, folder)) throw new Error("Task folder escapes the vault.");
  const taskFile = join(folder, "task.md");
  const taskMarkdown = await readFile(taskFile, "utf8");
  const task = parseRecord(taskMarkdown, "Task");
  if (task.taskId !== taskId || task.schemaVersion !== 1 || !Array.isArray(task.assignments)) throw new Error("Task identity or schema is invalid.");
  return { root, folder, taskFile, taskMarkdown, task };
}

async function loadProfile(root, projectId) {
  const projects = await realpath(join(root, "Projects"));
  if (!within(root, projects)) throw new Error("Projects folder escapes the vault.");
  const matches = [];
  for (const name of await readdir(projects)) {
    if (!/^[a-z0-9][a-z0-9_-]*\.md$/.test(name)) continue;
    let profile;
    try { profile = parseRecord(await readFile(join(projects, name), "utf8"), "Project profile"); }
    catch { continue; }
    if (profile.projectId === projectId) matches.push(profile);
  }
  if (matches.length !== 1) throw new Error(`Expected one project profile for ${projectId}; found ${matches.length}.`);
  const profile = matches[0];
  if (profile.schemaVersion !== 1 || !isAbsolute(required(profile.repository, "Profile repository")) || !isAbsolute(required(profile.kitRoot, "Profile kitRoot"))) {
    throw new Error("Project profile needs schemaVersion 1, an absolute repository, and an absolute kitRoot.");
  }
  return profile;
}

// Agents in a sandbox run Git as another user, so Git's ownership check applies. Older Git (as
// found in some sandboxes) reads safe.directory only from global or system config and ignores -c,
// so each call also gets a temporary global config that includes the user's own settings.
let safeConfigFolder = null;
function safeGitConfig(paths) {
  if (!safeConfigFolder) {
    safeConfigFolder = mkdtempSync(join(tmpdir(), "dev-flow-git-"));
    process.on("exit", () => rmSync(safeConfigFolder, { recursive: true, force: true }));
  }
  const file = join(safeConfigFolder, "config");
  const user = process.env.GIT_CONFIG_GLOBAL || join(homedir(), ".gitconfig");
  const lines = existsSync(user) ? ["[include]", `\tpath = ${user.replaceAll("\\", "/")}`] : [];
  lines.push("[safe]", ...paths.map(path => `\tdirectory = ${path.replaceAll("\\", "/")}`));
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

// safe.directory must cover the checkout being inspected (possibly a worktree) and the profile repository.
function gitRunner(cwd, paths, extraEnv = {}) {
  const unique = [...new Set(paths)];
  const safe = [...new Set(unique.flatMap(path => [path, path.replaceAll("\\", "/")]))].flatMap(path => ["-c", `safe.directory=${path}`]);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: safeGitConfig(unique), GIT_OPTIONAL_LOCKS: "0", ...extraEnv };
  return (...args) => execFileSync("git", [...safe, "-C", cwd, ...args], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"], env }).trim();
}

/**
 * The reviewed candidate: HEAD plus the tree of the whole working tree, as `git add -A` would stage it
 * (untracked files included, ignored files not). It is built in a temporary copy of the index, so the
 * checkout's own index and refs are untouched. Mission Control's Merge computes the same pair and
 * refuses when the task changed after its review. Keep both implementations in step.
 */
function reviewedCandidate(cwd, repository, checkoutRoot) {
  const plain = gitRunner(cwd, [repository, checkoutRoot]);
  let head = null;
  try { head = plain("rev-parse", "--verify", "HEAD"); }
  catch { /* An unborn branch has no revision yet. */ }
  const folder = mkdtempSync(join(tmpdir(), "dev-flow-candidate-"));
  try {
    const index = join(folder, "index");
    const real = resolve(cwd, plain("rev-parse", "--git-path", "index"));
    const git = gitRunner(cwd, [repository, checkoutRoot], { GIT_INDEX_FILE: index });
    if (existsSync(real)) copyFileSync(real, index);
    else git("read-tree", head ? "HEAD" : "--empty");
    git("add", "-A");
    return { head, tree: git("write-tree") };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

// A linked worktree lives outside the main checkout; its `.git` file points into the repository's
// .git/worktrees folder. This is a file check, so Git's ownership rules cannot block it.
async function linkedWorktreeRoot(cwd, repository) {
  const worktrees = await realpath(join(repository, ".git", "worktrees")).catch(() => null);
  if (!worktrees) return null;
  for (let dir = cwd; ; dir = dirname(dir)) {
    const marker = join(dir, ".git");
    const stat = await lstat(marker).catch(() => null);
    if (stat?.isDirectory()) return null;
    if (stat?.isFile()) {
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(marker, "utf8"));
      const gitdir = match ? await realpath(resolve(dir, match[1])).catch(() => null) : null;
      return gitdir && gitdir !== worktrees && within(worktrees, gitdir) ? dir : null;
    }
    if (dirname(dir) === dir) return null;
  }
}

function gitState(cwd, repository, checkoutRoot) {
  const git = gitRunner(cwd, [repository, checkoutRoot]);
  let head = null;
  try { head = git("rev-parse", "--verify", "HEAD"); }
  catch { /* An unborn branch has no revision yet. */ }
  const root = git("rev-parse", "--show-toplevel");
  const changes = git("status", "--porcelain=v1", "--untracked-files=normal").split(/\r?\n/).filter(Boolean);
  return { head, root, dirty: changes.length > 0, changes: changes.slice(0, 30), omittedChanges: Math.max(0, changes.length - 30) };
}

async function binding(args) {
  const loaded = await loadTask(required(args.task, "--task"));
  const host = JSON.parse(await readFile(join(loaded.root, "host.json"), "utf8"));
  if (host.schemaVersion !== 1 || host.serverId !== required(args.server, "--server") || host.hostId !== loaded.task.hostId) {
    throw new Error("Task does not belong to this host adapter.");
  }
  const workspaceId = required(args.workspace, "--workspace");
  if (!loaded.task.assignments.some(item => item.serverId === host.serverId && item.workspaceId === workspaceId)) {
    throw new Error("Task is not assigned to this workspace.");
  }
  const profile = await loadProfile(loaded.root, loaded.task.projectId);
  if (profile.hostId !== host.hostId) throw new Error("Project profile belongs to another host.");
  const cwd = await realpath(args.cwd || process.cwd());
  const repository = await realpath(profile.repository);
  const insideCheckout = within(repository, cwd);
  const worktreeRoot = insideCheckout ? null : await linkedWorktreeRoot(cwd, repository);
  if (!insideCheckout && !worktreeRoot) throw new Error("Current directory is outside the task's project repository.");
  const git = gitState(cwd, repository, worktreeRoot ?? repository);
  if (insideCheckout && !within(repository, await realpath(git.root))) throw new Error("Git root does not match the project profile.");
  return { ...loaded, host, profile, workspaceId, cwd, git, repository, checkoutRoot: worktreeRoot ?? repository };
}

async function runFolder(taskFolder, runId) {
  if (!runIdPattern.test(runId || "")) throw new Error("Invalid run ID.");
  const runs = await realpath(join(taskFolder, "runs"));
  if (!within(taskFolder, runs)) throw new Error("Runs folder escapes the task.");
  const folder = await realpath(join(runs, runId));
  if (!within(runs, folder)) throw new Error("Run folder escapes the task.");
  return folder;
}

async function latestRun(taskFolder) {
  let names;
  try { names = await readdir(join(taskFolder, "runs")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const runs = [];
  for (const name of names.filter(value => runIdPattern.test(value))) {
    const folder = await runFolder(taskFolder, name);
    const run = parseRecord(await readFile(join(folder, "run.md"), "utf8"), "Run");
    if (run.runId !== name) throw new Error("Run ID does not match its folder.");
    runs.push({ folder, run });
  }
  runs.sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
  return runs[0] || null;
}

async function context(args) {
  const bound = await binding(args);
  const latest = await latestRun(bound.folder);
  let handoff = null;
  if (latest) {
    try { handoff = await readFile(join(latest.folder, "handoff.md"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const decisions = latest ? (await readDecisions(latest.folder)).map(item => item.decision) : [];
  const findings = latest ? await readFindings(latest.folder, latest.run.runId) : [];
  const questions = latest ? await readQuestions(latest.folder) : [];
  const workflowInstructions = await createWorkflowInstructionsStore(bound.root).read({ serverId: bound.host.serverId, hostId: bound.host.hostId, projectId: bound.task.projectId });
  return { task: bound.task, taskMarkdown: bound.taskMarkdown, taskFile: bound.taskFile, profile: bound.profile, git: bound.git, latestRun: latest?.run || null, handoff, decisions, findings, questions, workflowInstructions: { ...workflowInstructions, prompt: workflowInstructionsPrompt(workflowInstructions) } };
}

async function start(args) {
  const bound = await binding(args);
  const agentId = args.agent || process.env.PASEO_AGENT_ID || null;
  if (agentId && !/^[a-zA-Z0-9_-]{1,128}$/.test(agentId)) throw new Error("Invalid agent ID.");
  const runs = join(bound.folder, "runs");
  await mkdir(runs, { recursive: true });
  const safeRuns = await realpath(runs);
  if (!within(bound.folder, safeRuns)) throw new Error("Runs folder escapes the task.");
  const runId = `run_${randomUUID()}`;
  const folder = join(safeRuns, runId);
  await mkdir(folder);
  await mkdir(join(folder, "events"));
  const now = new Date().toISOString();
  const run = {
    schemaVersion: 1, runId, taskId: bound.task.taskId, hostId: bound.host.hostId,
    projectId: bound.task.projectId, serverId: bound.host.serverId, workspaceId: bound.workspaceId, agentId,
    stage: "intake", outcome: "in_progress", createdAt: now, updatedAt: now,
    nextAction: "Confirm scope and write a plan.", gitHead: bound.git.head, gitDirty: bound.git.dirty,
    gitChanges: bound.git.changes, omittedChanges: bound.git.omittedChanges,
  };
  await writeFile(join(folder, "run.md"), markdownRecord(run, `# Run ${runId}\n\nTask: [[${bound.task.taskId}/task|${bound.task.title}]]`), { flag: "wx" });
  return { run, folder };
}

async function readInput(args) {
  const inputText = await readFile(required(args.input, "--input"), "utf8");
  if (Buffer.byteLength(inputText) > 100_000) throw new Error("Input is too large.");
  return JSON.parse(inputText);
}

function stringList(value, label) {
  if (!Array.isArray(value) || value.length > 20 || !value.every(item => typeof item === "string" && item.length <= 1000)) {
    throw new Error(`${label} must be an array of at most 20 short strings.`);
  }
  return value;
}

function agentIdOf(args) {
  const agentId = args.agent || process.env.PASEO_AGENT_ID || null;
  if (agentId && !/^[a-zA-Z0-9_-]{1,128}$/.test(agentId)) throw new Error("Invalid agent ID.");
  return agentId;
}

// The plugin uses the same lock file, so the CLI and Mission Control never write a run at once.
async function withRunLock(folder, action) {
  const lockPath = join(folder, ".write.lock");
  const lock = await open(lockPath, "wx");
  try { return await action(); }
  finally { await lock.close(); await unlink(lockPath); }
}

async function loadRun(bound, folder, runId) {
  const current = parseRecord(await readFile(join(folder, "run.md"), "utf8"), "Run");
  if (current.runId !== runId || current.taskId !== bound.task.taskId || current.workspaceId !== bound.workspaceId || current.serverId !== bound.host.serverId) {
    throw new Error("Run does not belong to the selected task and workspace.");
  }
  return current;
}

async function record(args) {
  const bound = await binding(args);
  const folder = await runFolder(bound.folder, required(args.run, "--run"));
  const input = await readInput(args);
  const agentId = agentIdOf(args);
  return withRunLock(folder, async () => appendEvent(bound, folder, await loadRun(bound, folder, args.run), input, agentId));
}

// Callers hold the run lock.
async function appendEvent(bound, folder, current, input, agentId) {
  if (!stages.has(input.stage) || !outcomes.has(input.outcome)) throw new Error("Invalid stage or outcome.");
  const summary = required(input.summary, "Event summary").trim();
  const nextAction = required(input.nextAction, "Event nextAction").trim();
  if (summary.length > 4000 || nextAction.length > 1000) throw new Error("Event text is too long.");
  stringList(input.evidence, "Evidence");
  if (["validate", "review"].includes(input.stage) && input.outcome === "completed" && input.evidence.length === 0) {
    throw new Error("Completed validation and review require evidence.");
  }
  {
    const file = join(folder, "run.md");
    const now = new Date().toISOString();
    const eventId = `event_${randomUUID()}`;
    const event = {
      schemaVersion: 1, eventId, runId: current.runId, taskId: current.taskId, agentId,
      stage: input.stage, outcome: input.outcome, at: now, evidence: input.evidence,
      gitHead: bound.git.head, gitDirty: bound.git.dirty,
      gitChanges: bound.git.changes, omittedChanges: bound.git.omittedChanges,
    };
    const eventBody = `# ${input.stage}: ${input.outcome}\n\n${summary}\n\n## Next action\n\n${nextAction}\n\n## Evidence\n\n${input.evidence.map(item => `- ${item}`).join("\n") || "None recorded."}`;
    const eventFile = join(folder, "events", `${eventId}.md`);
    await writeFile(eventFile, markdownRecord(event, eventBody), { flag: "wx" });
    const next = { ...current, stage: input.stage, outcome: input.outcome, updatedAt: now, nextAction, gitHead: bound.git.head, gitDirty: bound.git.dirty, gitChanges: bound.git.changes, omittedChanges: bound.git.omittedChanges };
    await atomicWrite(file, markdownRecord(next, `# Run ${current.runId}\n\nLatest event: [[events/${eventId}|${input.stage}]]\n\n${summary}`));
    if (input.stage === "handoff") {
      const handoff = { schemaVersion: 1, taskId: current.taskId, runId: current.runId, at: now, gitHead: bound.git.head, gitDirty: bound.git.dirty, gitChanges: bound.git.changes, omittedChanges: bound.git.omittedChanges };
      await atomicWrite(join(folder, "handoff.md"), markdownRecord(handoff, `# Handoff\n\n${summary}\n\n## Next action\n\n${nextAction}\n\n## Evidence\n\n${input.evidence.map(item => `- ${item}`).join("\n") || "None recorded."}`));
    }
    return { event, eventFile, run: next };
  }
}

const severities = new Set(["high", "medium", "low"]);
// Keep in step with plainLimits in plugins/mission-control/shared/decisions.ts.
const plainLimits = { built: 800, found: 800, reason: 300, description: 200, impact: 300 };
// Keep in step with questionLimits in plugins/mission-control/shared/questions.ts.
const questionLimits = { question: 500, status: 400, need: 200, recommendation: 300, statusSentences: 3 };
// Plain fields are read by a busy product owner, so they may not carry the technical details the summary keeps.
// Only what is unmistakably technical is refused; ordinary text (dates with slashes, "read/write", menu
// locations) must pass, so anything less certain is a warning the agent sees.
const refused = [
  [/\b(?:task|run|decision|finding|event)_[0-9a-f]{4,}(?:-[0-9a-f]+)*|\b(?:srv|wks|prj)_[A-Za-z0-9]{6,}/i, "an internal ID"],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i, "a commit hash"],
  // A drive, UNC or home path, any backslash path, or a slash path that ends in a file name.
  [/(?:^|[^\w])(?:[A-Za-z]:[\\/]|\\\\\w|~[\\/])|\w\\\w|\b[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z][A-Za-z0-9]{0,4}\b/, "a file path"],
];
const discouraged = [
  [/\b[\w-]+\.(?:m?[jt]sx?|cjs|json|md|cs|py|ps1|sh|ya?ml|toml|html|css)\b/i, "a file name"],
  [/\b[a-z]+[A-Z][a-z]+[A-Za-z]*\b|\b[a-z]+_[a-z_]+\b/, "a code name"],
  [/\b(?:tsc|npm|npx|zod|esbuild|OCR|Gortex|dev-flow|stderr|stdout|frontmatter|node_modules)\b/, "a tool name"],
];

function plainText(value, label, max, warnings, { optional = false } = {}) {
  if (optional && (value == null || value === "")) return "";
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${label} is too long (max ${max} characters).`);
  for (const [pattern, what] of refused) {
    const match = pattern.exec(text);
    if (match) throw new Error(`${label} must be plain language for the product owner; it contains ${what} ("${match[0].trim()}"). Keep technical details in the summary.`);
  }
  for (const [pattern, what] of discouraged) {
    const match = pattern.exec(text);
    if (match) warnings.push(`${label} may contain ${what} ("${match[0]}"). Say it in everyday words if you can.`);
  }
  return text;
}

// Plain fields are optional so older callers keep working; the plan-task and review-changes skills require them.
function decisionPlain(input, kind, warnings) {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("plain must be an object.");
  const action = input.recommendation?.action;
  if (!["accept", "fix", "stop"].includes(action)) throw new Error("plain.recommendation.action must be accept, fix or stop.");
  return {
    built: plainText(input.built, "plain.built", plainLimits.built, warnings),
    found: plainText(input.found, "plain.found", plainLimits.found, warnings, { optional: kind === "plan" }),
    recommendation: { action, reason: plainText(input.recommendation.reason, "plain.recommendation.reason", plainLimits.reason, warnings) },
  };
}

function findingPlain(input, index, warnings) {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new Error(`findings[${index}].plain must be an object.`);
  if (!["fix", "skip"].includes(input.recommend)) throw new Error(`findings[${index}].plain.recommend must be fix or skip.`);
  return {
    description: plainText(input.description, `findings[${index}].plain.description`, plainLimits.description, warnings),
    impact: plainText(input.impact, `findings[${index}].plain.impact`, plainLimits.impact, warnings),
    recommend: input.recommend,
  };
}
// Agents may only report a fix or a verification. Only the user moves findings out of `open`.
const agentFindingMoves = { submitted: ["awaiting_verification"], awaiting_verification: ["resolved", "submitted"] };

async function readFindings(folder, runId) {
  let text;
  try { text = await readFile(join(folder, "findings.json"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const parsed = JSON.parse(text);
  if (parsed.schemaVersion !== 1 || parsed.runId !== runId || !Array.isArray(parsed.findings)) throw new Error("findings.json is invalid.");
  return parsed.findings;
}

async function writeFindings(folder, runId, findings) {
  await atomicWrite(join(folder, "findings.json"), `${JSON.stringify({ schemaVersion: 1, runId, findings }, null, 2)}\n`);
}

async function readDecisions(folder) {
  let names;
  try { names = await readdir(join(folder, "decisions")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const decisions = [];
  for (const name of names.filter(value => /^decision_[a-f0-9-]+\.md$/.test(value))) {
    const text = await readFile(join(folder, "decisions", name), "utf8");
    const decision = parseRecord(text, "Decision");
    if (`${decision.decisionId}.md` !== name) throw new Error("Decision ID does not match its file.");
    decisions.push({ decision, body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim() });
  }
  return decisions.sort((a, b) => a.decision.requestedAt.localeCompare(b.decision.requestedAt));
}

async function requestDecision(args) {
  const bound = await binding(args);
  const folder = await runFolder(bound.folder, required(args.run, "--run"));
  const input = await readInput(args);
  const agentId = agentIdOf(args);
  if (!["plan", "review"].includes(input.kind)) throw new Error("kind must be plan or review.");
  const question = required(input.question, "question").trim();
  const summary = required(input.summary, "summary").trim();
  if (question.length > 500 || summary.length > 8000) throw new Error("Decision text is too long.");
  const evidence = stringList(input.evidence ?? [], "Evidence");
  const requested = input.findings ?? [];
  if (!Array.isArray(requested) || requested.length > 50) throw new Error("findings must be an array of at most 50 items.");
  if (input.kind === "plan" && requested.length) throw new Error("Plan decisions have no findings.");
  for (const item of requested) {
    if (!item || typeof item.title !== "string" || !item.title.trim() || item.title.length > 300 || !severities.has(item.severity)
      || typeof (item.detail ?? "") !== "string" || (item.detail ?? "").length > 4000 || (item.file != null && (typeof item.file !== "string" || item.file.length > 500))) {
      throw new Error("Each finding needs a title (max 300), severity high|medium|low, optional detail and file.");
    }
  }
  const warnings = [];
  const plain = decisionPlain(input.plain, input.kind, warnings);
  const plains = requested.map((item, index) => findingPlain(item.plain, index, warnings));
  if (plain && plains.some(item => !item)) throw new Error("When plain is given, every finding needs plain too.");
  if (plain && input.kind === "review") {
    const fixes = plains.filter(item => item?.recommend === "fix").length;
    if (plain.recommendation.action === "fix" && !fixes) throw new Error("A review that recommends fixing needs at least one finding recommended for fixing.");
    if (plain.recommendation.action === "accept" && fixes) throw new Error("A review that recommends accepting can't recommend fixing a finding. Recommend skip for each finding, or recommend fix overall.");
  }
  // A review records exactly what it covered, so a later change can be told apart from the reviewed work.
  const candidate = input.kind === "review" ? reviewedCandidate(bound.cwd, bound.repository, bound.checkoutRoot) : null;
  return withRunLock(folder, async () => {
    const current = await loadRun(bound, folder, args.run);
    const open = (await readDecisions(folder)).find(item => item.decision.status === "open");
    if (open) throw new Error(`Decision ${open.decision.decisionId} is still open. Wait for the user.`);
    const now = new Date().toISOString();
    const decisionId = `decision_${randomUUID()}`;
    const findings = requested.map((item, index) => ({
      findingId: `finding_${randomUUID()}`, decisionId, title: item.title.trim(), severity: item.severity,
      detail: (item.detail ?? "").trim(), file: item.file ?? null, status: "open", updatedAt: now, evidence: [], plain: plains[index],
    }));
    if (findings.length) await writeFindings(folder, current.runId, [...await readFindings(folder, current.runId), ...findings]);
    const decision = {
      schemaVersion: 1, decisionId, taskId: current.taskId, runId: current.runId, serverId: current.serverId, workspaceId: current.workspaceId,
      agentId: agentId || current.agentId || null, kind: input.kind, status: "open", question, requestedAt: now,
      gitHead: bound.git.head, gitDirty: bound.git.dirty, evidence, findingIds: findings.map(item => item.findingId),
      resolvedAt: null, note: null, resume: null, candidate, plain,
    };
    await mkdir(join(folder, "decisions"), { recursive: true });
    await writeFile(join(folder, "decisions", `${decisionId}.md`), markdownRecord(decision, summary), { flag: "wx" });
    const event = await appendEvent(bound, folder, current, {
      stage: input.kind, outcome: "waiting", evidence: [...evidence, `decision ${decisionId}`].slice(-20),
      summary: `Requested a ${input.kind} decision: ${question}`,
      nextAction: `Wait for the user's decision ${decisionId} in Mission Control. Do not continue until it arrives.`,
    }, agentId);
    for (const warning of warnings) process.stderr.write(`Warning: ${warning}\n`);
    return { decision, findings, event: event.event, warnings };
  });
}

async function readQuestions(folder) {
  let names;
  try { names = await readdir(join(folder, "questions")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const questions = [];
  for (const name of names.filter(value => /^question_[a-f0-9-]+\.md$/.test(value))) {
    const file = join(folder, "questions", name);
    const question = parseRecord(await readFile(file, "utf8"), "Question");
    if (`${question.questionId}.md` !== name) throw new Error("Question ID does not match its file.");
    questions.push({ question, file });
  }
  return questions.sort((a, b) => a.question.askedAt.localeCompare(b.question.askedAt)).map(item => item.question);
}

const sentenceCount = text => text.split(/(?<=[.!?])\s+(?=\S)/).length;

/**
 * An ordinary question for the user, recorded when the agent stops to ask it, so Attention can show
 * where things stand and what's needed without opening the chat. A newer question replaces the run's
 * earlier open one; the user answers from Attention's Reply box or in the chat.
 */
async function ask(args) {
  const bound = await binding(args);
  const folder = await runFolder(bound.folder, required(args.run, "--run"));
  const input = await readInput(args);
  const question = required(input.question, "question").trim();
  if (question.length > questionLimits.question) throw new Error(`question is too long (max ${questionLimits.question} characters).`);
  if (input.plain == null || typeof input.plain !== "object" || Array.isArray(input.plain)) throw new Error("plain must be an object with status and need.");
  const warnings = [];
  const plain = {
    status: plainText(input.plain.status, "plain.status", questionLimits.status, warnings),
    need: plainText(input.plain.need, "plain.need", questionLimits.need, warnings),
    recommendation: plainText(input.plain.recommendation, "plain.recommendation", questionLimits.recommendation, warnings, { optional: true }) || null,
  };
  if (sentenceCount(plain.status) > questionLimits.statusSentences) warnings.push(`plain.status has more than ${questionLimits.statusSentences} sentences; Attention shows about three lines.`);
  if (sentenceCount(plain.need) > 1) warnings.push("plain.need should be one sentence.");
  return withRunLock(folder, async () => {
    const current = await loadRun(bound, folder, args.run);
    const agentId = agentIdOf(args) || current.agentId || null;
    if (!agentId) throw new Error("No agent is linked to this run; pass --agent so the reply reaches you.");
    const now = new Date().toISOString();
    const questionId = `question_${randomUUID()}`;
    await mkdir(join(folder, "questions"), { recursive: true });
    // Only the latest question waits for an answer.
    for (const earlier of await readQuestions(folder)) {
      if (earlier.status !== "open") continue;
      await atomicWrite(join(folder, "questions", `${earlier.questionId}.md`), markdownRecord({ ...earlier, status: "replaced", answeredAt: now }, "# Question"));
    }
    const record = {
      schemaVersion: 1, questionId, taskId: current.taskId, runId: current.runId, serverId: current.serverId, workspaceId: current.workspaceId,
      agentId, status: "open", question, askedAt: now, answeredAt: null, answer: null, plain,
    };
    await writeFile(join(folder, "questions", `${questionId}.md`), markdownRecord(record, "# Question"), { flag: "wx" });
    const event = await appendEvent(bound, folder, current, {
      stage: current.stage, outcome: "waiting", evidence: [`question ${questionId}`],
      summary: `Asked the user: ${question}`,
      nextAction: "Wait for the user's reply, from Mission Control's Attention tab or the chat.",
    }, agentId);
    for (const warning of warnings) process.stderr.write(`Warning: ${warning}\n`);
    return { question: record, event: event.event, warnings };
  });
}

async function showDecision(args) {
  const bound = await binding(args);
  const folder = await runFolder(bound.folder, required(args.run, "--run"));
  await loadRun(bound, folder, args.run);
  const decisionId = required(args.decision, "--decision");
  const found = (await readDecisions(folder)).find(item => item.decision.decisionId === decisionId);
  if (!found) throw new Error("Decision not found in this run.");
  const findings = await readFindings(folder, args.run);
  return { ...found, findings: findings.filter(item => found.decision.findingIds.includes(item.findingId)) };
}

async function updateFinding(args) {
  const bound = await binding(args);
  const folder = await runFolder(bound.folder, required(args.run, "--run"));
  const findingId = required(args.finding, "--finding");
  const status = required(args.status, "--status");
  const evidence = (args.evidence ?? "").trim();
  if (evidence.length > 1000) throw new Error("Evidence is too long.");
  if (status === "resolved" && !evidence) throw new Error("Resolving a finding requires --evidence from the fresh review that verified it.");
  if (status === "awaiting_verification" && !evidence) throw new Error("Describe the fix with --evidence.");
  return withRunLock(folder, async () => {
    await loadRun(bound, folder, args.run);
    const findings = await readFindings(folder, args.run);
    const finding = findings.find(item => item.findingId === findingId);
    if (!finding) throw new Error("Finding not found in this run.");
    if (!(agentFindingMoves[finding.status] ?? []).includes(status)) {
      throw new Error(`Cannot move a finding from ${finding.status} to ${status}. Only the user sends open findings for fixing.`);
    }
    const next = { ...finding, status, updatedAt: new Date().toISOString(), evidence: evidence ? [...finding.evidence, evidence].slice(-20) : finding.evidence };
    await writeFindings(folder, args.run, findings.map(item => item.findingId === findingId ? next : item));
    return { finding: next };
  });
}

const workspaceStatusColors = { Ready: "emerald", "In Progress": "sky", Review: "violet", Blocked: "red", Paused: "amber", Done: "teal" };
const workspaceLabelColors = new Set(["violet", "sky", "emerald", "orange", "pink", "indigo", "teal", "red", "amber", "blue"]);
const workspaceLabelKey = name => name.replace(/\s+/g, " ").trim().toLowerCase();
const finishedTask = task => ["delivered", "closed"].includes(task.status);

async function linkedWorkspaceTasks(bound) {
  const root = await realpath(join(bound.root, "Tasks"));
  const tasks = [];
  for (const name of await readdir(root)) {
    const id = name.endsWith(".md") ? name.slice(0, -3) : name;
    if (!taskIdPattern.test(id)) continue;
    const entry = join(root, name);
    const stat = await lstat(entry);
    if (stat.isSymbolicLink()) throw new Error("Cannot establish workspace ownership through linked task entries.");
    const file = await realpath(stat.isDirectory() ? join(entry, "task.md") : entry);
    if (!within(root, file)) throw new Error("Task record escapes the vault.");
    const task = parseRecord(await readFile(file, "utf8"), "Task");
    if (task.schemaVersion !== 1 || task.taskId !== id || !Array.isArray(task.assignments)) throw new Error("Task identity/schema is invalid.");
    if (task.assignments.some(item => item.serverId === bound.host.serverId && item.workspaceId === bound.workspaceId)) tasks.push(task);
  }
  return tasks;
}

function guardWorkspaceStatus(bound, tasks, label) {
  const selected = tasks.find(task => task.taskId === bound.task.taskId);
  if (!selected || selected.status !== bound.task.status) throw new Error("Task binding/status changed; reload task context before labeling.");
  const active = tasks.filter(task => !finishedTask(task));
  if (active.some(task => task.taskId !== selected.taskId)) throw new Error("Shared workspace: its coordinator must choose the overall label explicitly with assign/remove; one task cannot replace its status.");
  if (label === "Done" && (!finishedTask(selected) || active.length)) throw new Error("Done requires recorded delivery/closure and no active tasks.");
  if (label === "Blocked" && selected.status !== "blocked" && bound.latestRun?.outcome !== "blocked") throw new Error("Blocked requires a recorded blocker; waiting is not blocked.");
  if (label === "Ready") {
    const run = bound.latestRun;
    const latestPlan = bound.decisions.filter(item => item.kind === "plan").sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
    const approvedPlan = run?.stage === "plan" && run.outcome === "completed" && latestPlan?.status === "approved"
      && latestPlan.runId === run.runId && latestPlan.taskId === selected.taskId && latestPlan.serverId === bound.host.serverId && latestPlan.workspaceId === bound.workspaceId;
    if (finishedTask(selected) || bound.decisions.some(item => item.status === "open") || (latestPlan && latestPlan.status !== "approved") || (selected.status !== "ready" && !approvedPlan)) throw new Error("Ready requires recorded readiness or an approved plan, an active task, and no open decision.");
  }
  if (label === "Review" && selected.status !== "in_review" && bound.latestRun?.stage !== "review") throw new Error("Review requires a recorded review checkpoint.");
  if (label === "In Progress" && finishedTask(selected)) throw new Error("A delivered/closed task is not in progress.");
}

async function guardWorkspaceAgents(bound, args, api) {
  const roster = await api.agents.list();
  if (!Array.isArray(roster.entries) || !roster.pageInfo || roster.pageInfo.hasMore || roster.pageInfo.nextCursor) throw new Error("Cannot establish a complete agent roster before setting Done.");
  const caller = agentIdOf(args);
  if (roster.entries.some(({ agent }) => agent.workspaceId === bound.workspaceId && !agent.archivedAt && agent.id !== caller && (!["idle", "closed"].includes(agent.status) || agent.pendingPermissions?.length))) throw new Error("Done requires no other active or permission-waiting agent in this workspace.");
}

// Isolate Paseo's exported internal label API here. Public PaseoApi and MCP lack these methods.
async function applyWorkspaceLabel(bound, args, client, api, readTasks = linkedWorkspaceTasks) {
  const action = args.action || "get";
  if (!["get", "assign", "remove", "status"].includes(action)) throw new Error("--action must be get, assign, remove or status.");
  const name = action === "get" ? "" : required(args.label, "--label").replace(/\s+/g, " ").trim();
  if (name.length > 100 || (action !== "get" && !name)) throw new Error("Label name must be 1–100 characters.");
  if (args.color && !workspaceLabelColors.has(args.color)) throw new Error("Unknown label color.");
  if (action === "status" && (!Object.hasOwn(workspaceStatusColors, name) || !args.reason?.trim())) throw new Error("status requires a workflow label and --reason describing the recorded state.");
  const read = async () => {
    const daemon = await client.getDaemonStatus();
    if (daemon.serverId !== bound.host.serverId) throw new Error("Connected daemon does not match the task host.");
    const workspace = await api.workspaces.ref(bound.workspaceId).refresh();
    if (!workspace || workspace.id !== bound.workspaceId || workspace.projectId !== bound.task.projectId || workspace.archivingAt) throw new Error("Live workspace is missing, archiving or belongs to another project.");
    if (await realpath(workspace.workspaceDirectory) !== await realpath(bound.git.root)) throw new Error("Live workspace directory does not match the task checkout.");
    const catalog = await client.listWorkspaceLabels();
    if (!Array.isArray(workspace.labels) || !Array.isArray(catalog.labels)) throw new Error("Workspace-label API is unavailable.");
    return { daemon, workspace, catalog };
  };
  let wrote = false;
  try {
    const before = await read();
    const tasks = await readTasks(bound);
    if (action === "get") return { taskId: bound.task.taskId, serverId: bound.host.serverId, workspaceId: bound.workspaceId, labels: before.workspace.labels, catalog: before.catalog.labels, tasks: tasks.map(task => ({ taskId: task.taskId, title: task.title, status: task.status })), daemonVersion: before.daemon.version };
    if (action === "status") {
      guardWorkspaceStatus(bound, tasks, name);
      if (name === "Done") await guardWorkspaceAgents(bound, args, api);
    }
    const matches = before.catalog.labels.filter(label => workspaceLabelKey(label.name) === workspaceLabelKey(name));
    if (matches.length > 1) throw new Error("Label name is ambiguous in the host catalog.");
    const label = matches[0] || { name, color: args.color || workspaceStatusColors[name] || "sky" };
    if (matches[0] && args.color && args.color !== matches[0].color) throw new Error("Assignment must not recolor an existing shared definition.");
    const assigned = action !== "remove";
    if (before.workspace.labels.some(value => workspaceLabelKey(value) === workspaceLabelKey(label.name)) !== assigned) {
      wrote = true;
      await client.setWorkspaceLabel({ workspaceId: bound.workspaceId, label, assigned });
    }
    const removed = [];
    if (action === "status") {
      for (const value of before.workspace.labels.filter(value => Object.keys(workspaceStatusColors).some(status => workspaceLabelKey(status) === workspaceLabelKey(value)) && workspaceLabelKey(value) !== workspaceLabelKey(label.name))) {
        const definition = before.catalog.labels.find(item => workspaceLabelKey(item.name) === workspaceLabelKey(value));
        if (!definition) throw new Error("An existing status has no catalog definition; inspect the workspace.");
        wrote = true;
        await client.setWorkspaceLabel({ workspaceId: bound.workspaceId, label: definition, assigned: false });
        removed.push(value);
      }
    }
    const after = await read();
    const preserved = before.workspace.labels.filter(value => workspaceLabelKey(value) !== workspaceLabelKey(label.name) && !removed.includes(value));
    if (after.workspace.labels.some(value => workspaceLabelKey(value) === workspaceLabelKey(label.name)) !== assigned || preserved.some(value => !after.workspace.labels.includes(value)) || removed.some(value => after.workspace.labels.includes(value))) throw new Error("Live assignment verification failed or another writer changed the workspace.");
    if (action === "status") {
      guardWorkspaceStatus(bound, await readTasks(bound), name);
      if (name === "Done") await guardWorkspaceAgents(bound, args, api);
      if (after.workspace.labels.some(value => Object.keys(workspaceStatusColors).some(status => workspaceLabelKey(status) === workspaceLabelKey(value)) && workspaceLabelKey(value) !== workspaceLabelKey(label.name))) throw new Error("Another status appeared during the change; inspect the workspace.");
    }
    return { verified: true, verifiedAt: new Date().toISOString(), taskId: bound.task.taskId, serverId: bound.host.serverId, workspaceId: bound.workspaceId, action, label: label.name, reason: args.reason || null, before: before.workspace.labels, after: after.workspace.labels, daemonVersion: after.daemon.version };
  } catch (error) {
    if (wrote) throw new Error(`${error.message} A label change may have applied; run workspace-label --action get before retrying.`, { cause: error });
    throw error;
  }
}

async function workspaceLabel(args) {
  const bound = await binding(args);
  const endpoint = new URL(args.url || "ws://127.0.0.1:6767/ws");
  if (!["ws:", "wss:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("--url must be a WebSocket endpoint without embedded credentials.");
  const latest = await latestRun(bound.folder);
  bound.latestRun = latest?.run || null;
  bound.decisions = latest ? (await readDecisions(latest.folder)).map(item => item.decision) : [];
  const require = createRequire(new URL("../plugins/mission-control/package.json", import.meta.url));
  const { DaemonClient } = await import(pathToFileURL(require.resolve("@getpaseo/client/internal/daemon-client")));
  const { createPaseoApi } = await import(pathToFileURL(require.resolve("@getpaseo/client")));
  const client = new DaemonClient({ url: endpoint.href, clientId: `dev-flow-labels-${randomUUID()}`, clientType: "cli", connectTimeoutMs: 10_000, reconnect: { enabled: false }, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    if (typeof client.setWorkspaceLabel !== "function" || typeof client.listWorkspaceLabels !== "function") throw new Error("Installed Paseo client lacks the workspace-label API.");
    await client.connect();
    return await applyWorkspaceLabel(bound, args, client, createPaseoApi(client));
  } finally { await client.close(); }
}

const help = `Usage: dev-flow.mjs context|start|record|request-decision|ask|decision|finding|workspace-label --task ID --server ID --workspace ID [--run ID] [--input JSON] [--decision ID] [--finding ID --status STATUS --evidence TEXT] [--agent ID] [--cwd PATH]

workspace-label [--action get|assign|remove|status] [--label NAME] [--color COLOR] [--reason TEXT] [--url ws://host:port/ws]
  get reads the live labels, catalog and linked tasks. assign creates a missing label and assigns it;
  remove detaches it without deleting its shared definition. status replaces workflow status labels
  only in a task-owned workspace, requires --reason, and refuses other active linked tasks.
  All changes verify the exact live host/project/checkout and read back assignments. A write timeout
  is unconfirmed: read get before retrying. Uses a capability-checked internal client API; no private
  Paseo files are written. Labels never alter task status or grant approval. See docs/agent-workflow.md.

request-decision --input is a JSON file:
  { "kind": "plan" | "review",
    "question": "...", "summary": "<technical summary, max 8000>", "evidence": ["<paths>"],
    "plain": {
      "built": "<what the user gets: what was built or planned, 1-2 sentences, max ${plainLimits.built}>",
      "found": "<what the review found, in everyday terms, max ${plainLimits.found}; optional for plans>",
      "recommendation": { "action": "accept" | "fix" | "stop", "reason": "<one line, max ${plainLimits.reason}>" } },
    "findings": [{ "title": "...", "severity": "high" | "medium" | "low", "detail": "...", "file": "...",
      "plain": { "description": "<the problem in plain words, max ${plainLimits.description}>",
                 "impact": "<what happens if it is skipped, max ${plainLimits.impact}>", "recommend": "fix" | "skip" } }] }

The plain fields are written for a busy product owner: no IDs, commit hashes, paths, file or tool names.
Internal IDs, commit hashes and file paths are refused; file, code and tool names are allowed but come
back as warnings (in the output's "warnings" and on stderr) so you can reword them.
When plain is given, every finding needs plain too. A review recommending "fix" needs a finding recommended
for fixing; one recommending "accept" recommends skipping every finding. Mission Control shows the plain
fields first and keeps question, summary, evidence and finding details under Technical details.

ask --run ID --input JSON records an ordinary question, whenever you stop to ask the user something that
isn't a plan or review decision. Attention shows it as a "Waiting for you" card with a Reply box:
  { "question": "<the question as you ask it in the chat, max ${questionLimits.question}>",
    "plain": {
      "status": "<where things stand, at most ${questionLimits.statusSentences} sentences, max ${questionLimits.status}>",
      "need": "<what you need from the user, one sentence, max ${questionLimits.need}>",
      "recommendation": "<optional: what you recommend, max ${questionLimits.recommendation}>" } }
The plain fields follow the same rules as a decision's. Longer text is rejected. A new question replaces
the run's earlier open one. Ask in the chat too, then stop and wait for the reply.`;

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "help") {
    process.stdout.write(`${help}\n`);
    return;
  }
  const args = options(argv);
  const commands = { context, start, record, "request-decision": requestDecision, ask, decision: showDecision, finding: updateFinding, "workspace-label": workspaceLabel };
  const result = Object.hasOwn(commands, command) ? await commands[command](args) : null;
  if (!result) throw new Error(`Unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
