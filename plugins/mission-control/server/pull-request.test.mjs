import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createMergeService, reviewCandidate } = require("./merge.ts");
const { createPullRequestService, mapState, pullRequestBody, workItemOf } = require("./pull-request.ts");
const { createDeliveryResults } = require("./delivery-results.ts");
const { deliverTaskSource, recordTaskPullRequest } = require("./tasks.ts");
const { pullRequestStatusSchema, pullRequestReplySchema, cleanupReplySchema, trackedPullRequestSchema, deliveryResultSchema } = require("../shared/pull-request.ts");
const { decisionSchema } = require("../shared/decisions.ts");
const { deliveryFor } = require("../shared/delivery.ts");

const serverId = "srv_test";
const taskId = "task_5678abcd-0000-4000-8000-000000000000";
const runId = "run_5678abcd-0000-4000-8000-000000000000";
const branch = "task/5678abcd-add-greeting";
const token = "bbtoken_Zx9QmL2vR7tK4pW8sN3yB6cH1jD5fG0a";
const markdown = fields => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n# Add greeting\n`;

// A fake gh and az: Node scripts run as real processes, which log their arguments (and the body file they
// were given) and answer from a state file, like the real tools would.
const fakeTool = `
const fs = require("fs");
const [tool, ...args] = process.argv.slice(2);
const log = process.env.FAKE_LOG;
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, "utf8"));
const entry = { tool, args };
const flag = name => args[args.indexOf(name) + 1];
if (args.includes("--body-file")) entry.body = fs.readFileSync(flag("--body-file"), "utf8");
if (args.includes("--description")) entry.body = fs.readFileSync(flag("--description").slice(1), "utf8");
fs.appendFileSync(log, JSON.stringify(entry) + "\\n");
const answer = state[tool + " " + args.slice(0, 2).join(" ")] ?? state[tool + " " + args[0]];
if (!answer) { process.stderr.write("fake " + tool + ": unexpected " + args.join(" ")); process.exit(2); }
process.stdout.write(answer.stdout ?? "");
process.stderr.write(answer.stderr ?? "");
process.exit(answer.code ?? 0);
`;

const answers = {
  "gh auth": { stdout: "github.com\n  ✓ Logged in to github.com account octo (keyring)\n" },
  "gh pr create": { stdout: "https://github.com/acme/widgets/pull/42\n" },
  "gh pr view": { stdout: JSON.stringify({ state: "OPEN", isDraft: true }) },
  "az extension show": { stdout: JSON.stringify({ name: "azure-devops", version: "1.0.1" }) },
  "az account show": { stdout: JSON.stringify({ user: { name: "dev@contoso.com" } }) },
  "az devops project": { stdout: JSON.stringify({ value: [{ name: "Web Shop" }] }) },
  "az repos pr": { stdout: JSON.stringify({ pullRequestId: 77, status: "active", isDraft: true }) },
};

/**
 * A scratch repository on master with a task worktree, a bare "origin" that pushes really go to (its URL
 * says GitHub, Azure DevOps or Bitbucket, but pushInsteadOf sends pushes to the bare folder), a task folder
 * with an approved review and a handoff, fake gh and az, and a local HTTP server for Bitbucket's API.
 */
async function scenario(t, { remote = "https://github.com/acme/widgets.git", mode = "pull-request", ticket, agentStatus = "idle" } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "mission-pr-")));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const repo = join(base, "repo");
  const origin = join(base, "origin.git");
  const worktree = join(base, "worktrees", "5678abcd-add-greeting");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "master", origin]);
  execFileSync("git", ["init", "-q", "-b", "master", repo]);
  git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.com"); git(repo, "config", "core.autocrlf", "false");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "config", `url.${origin.replaceAll("\\", "/")}.pushInsteadOf`, remote);
  await mkdir(join(repo, ".github"));
  await writeFile(join(repo, ".github", "PULL_REQUEST_TEMPLATE.md"), "## What changed\n\n## How to test\n");
  await writeFile(join(repo, "base.txt"), "base\n");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "base");
  const baseCommit = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "-q", "origin", "master");
  // As a fetch would leave it: origin/master where it is on origin.
  git(repo, "update-ref", "refs/remotes/origin/master", baseCommit);
  git(repo, "worktree", "add", "-q", "-b", branch, worktree, "master");

  const vault = join(base, "vault");
  const folder = join(vault, "Tasks", taskId);
  await mkdir(join(folder, "runs", runId), { recursive: true });
  const task = {
    schemaVersion: 1, taskId, hostId: "personal", projectId: "prj_work", title: ticket ? `${ticket.key} · Add greeting` : "Add greeting", acceptanceCriteria: "Works.", status: "in_progress", source: "manual",
    assignments: [{ serverId, workspaceId: "wks_main" }, { serverId, workspaceId: "wks_task" }], createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z",
    worktree: { workspaceId: "wks_task", branch, baseCommit, sourceWorkspaceId: "wks_main", createdAt: "2026-09-20T00:00:00Z" },
    ...(ticket ? { ticket } : {}),
  };
  await writeFile(join(folder, "task.md"), markdown(task));
  await writeFile(join(folder, "status.md"), "# Status log\n\nCreated 2026-09-20T00:00:00Z. Initial state: ready.\n");
  await writeFile(join(folder, "runs", runId, "handoff.md"), "---\nschemaVersion: 1\n---\n\n# Handoff\n\nAdds a greeting file.\nCheck greeting.txt.\n\n## Next action\n\nReview.\n");
  // The service reads task.md again before each step, as the real task sources do.
  const sources = async () => [{ task: JSON.parse(JSON.stringify(readTask())), folder, file: join(folder, "task.md") }];
  const readTask = () => {
    const text = readFileSync(join(folder, "task.md"), "utf8");
    const fields = {};
    for (const line of /^---\n([\s\S]*?)\n---/.exec(text)[1].split("\n")) fields[line.slice(0, line.indexOf(":"))] = JSON.parse(line.slice(line.indexOf(":") + 1));
    return fields;
  };
  const run = {
    schemaVersion: 1, runId, taskId, hostId: "personal", projectId: "prj_work", serverId, workspaceId: "wks_task", stage: "handoff", outcome: "completed",
    createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z", nextAction: "Deliver.", agentId: "agent-1", gitHead: baseCommit, gitDirty: true, gitChanges: [], omittedChanges: 0,
  };
  const decisions = { open: [], recent: [] };
  async function review(status = "approved") {
    const decision = decisionSchema.parse({
      schemaVersion: 1, decisionId: "decision_5678abcd-0000-4000-8000-000000000000", taskId, runId, serverId, workspaceId: "wks_task", agentId: "agent-1", kind: "review", status,
      question: "Approve?", requestedAt: "2026-09-22T00:00:00Z", gitHead: git(worktree, "rev-parse", "HEAD"), gitDirty: true, evidence: [], findingIds: [],
      resolvedAt: status === "open" ? null : "2026-09-22T01:00:00Z", note: null, resume: null, candidate: await reviewCandidate(worktree),
    });
    const entry = { decision, summary: "", taskTitle: task.title, projectId: "prj_work", findings: [], unverifiedFindings: 0, revision: "r" };
    decisions.open = status === "open" ? [entry] : [];
    decisions.recent = status === "open" ? [] : [entry];
  }

  const events = [];
  const agent = { status: agentStatus, activeTurn: null, pendingPermissions: [], archivedAt: null };
  const paseo = {
    agents: { ref: () => ({ refresh: async () => ({ agent }), send: async text => { events.push(["send", text]); } }) },
    workspaces: { ref: id => ({ archive: async () => { events.push(["archive", id]); git(repo, "worktree", "remove", "--force", worktree); return { archivedAt: "2026-09-27T00:00:00Z", error: null }; } }) },
  };

  // Fake tools and their log.
  const fake = join(base, "fake-tool.cjs");
  const log = join(base, "tools.log");
  const stateFile = join(base, "tools.json");
  await writeFile(fake, fakeTool);
  await writeFile(log, "");
  const tools = { ...answers };
  const saveTools = () => writeFile(stateFile, JSON.stringify(tools));
  await saveTools();
  const command = name => ({ file: process.execPath, prefix: [fake, name], label: name, env: { FAKE_LOG: log, FAKE_STATE: stateFile } });
  const calls = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  let gh = command("gh");
  let az = command("az");

  // Bitbucket Cloud's API.
  const requests = [];
  const bitbucket = { create: { status: 201, body: { id: 5, links: { html: { href: "https://bitbucket.org/team/app/pull-requests/5" } } } }, view: { status: 200, body: { id: 5, state: "OPEN", draft: true } } };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: body ? JSON.parse(body) : null });
      // The pull request's commits, by page; each Clean up check reads them again. NEXT becomes page 2's URL.
      const page = request.url.includes("/commits") ? bitbucket.commits?.[request.url.includes("page=2") ? 1 : 0] : null;
      const commitsPage = page && page.body.next === "NEXT" ? { ...page, body: { ...page.body, next: `http://127.0.0.1:${server.address().port}/2.0/repositories/team/app/pullrequests/5/commits?page=2` } } : page;
      const answer = request.method === "POST" ? bitbucket.create : commitsPage ?? bitbucket.view;
      response.writeHead(answer.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise(done => server.close(done)));
  let bitbucketAuth = async () => ({ header: `Bearer ${token}`, source: "the BITBUCKET_TOKEN environment variable" });

  const results = createDeliveryResults({ file: join(base, "delivery-results.json") });
  const settings = { mode, titleTemplate: "", projects: {} };
  const merges = createMergeService({
    results, sources, decisions: async () => decisions, runs: async () => [run], projectRoot: async () => repo,
    clearReviewMarks: async id => { events.push(["marks", id]); }, deliver: deliverTaskSource,
    deliveryMode: async projectId => deliveryFor(settings, projectId).mode,
  });
  const service = createPullRequestService({
    results, sources, runs: async () => [run],
    evaluate: (server, id, api, evaluateMode) => merges.evaluate(server, id, api, evaluateMode),
    delivery: async projectId => deliveryFor(settings, projectId),
    targetBranch: async () => "master",
    projectRoot: async () => repo,
    record: recordTaskPullRequest, deliver: deliverTaskSource,
    clearReviewMarks: async id => { events.push(["marks", id]); },
    gh: async () => gh, az: async () => az,
    bitbucketApi: `http://127.0.0.1:${server.address().port}/2.0`, bitbucketAuth: () => bitbucketAuth(),
    now: () => new Date("2026-09-27T12:00:00Z"),
  });
  const check = async () => pullRequestStatusSchema.parse(await service.check({ serverId, taskId }, paseo));
  // text: what the user confirmed in the dialog: { commitMessage, title, body }.
  const start = async (fingerprint, dryRun = false, text = {}) => pullRequestReplySchema.parse(await service.start({ serverId, taskId, fingerprint, dryRun, ...text }, paseo));
  return {
    base, repo, origin, worktree, folder, git, check, start, service, merges, results, review, events, calls, tools, saveTools, requests, bitbucket, settings, readTask, paseo, run,
    setGh: value => { gh = value; }, setAz: value => { az = value; }, setBitbucketAuth: value => { bitbucketAuth = value; },
    list: async (read = true) => (await service.list({ serverId, read })).pullRequests.map(item => trackedPullRequestSchema.parse(item)),
    cleanup: async () => cleanupReplySchema.parse(await service.cleanup({ serverId, taskId }, paseo)),
  };
}

const failing = status => status.checks.filter(item => !item.ok).map(item => item.id);
const detail = (status, id) => status.checks.find(item => item.id === id)?.detail;
const originHas = (s, name) => { try { return s.git(s.origin, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`); } catch { return ""; } };

test("the plan lists the commit, the push and the draft pull request, and a dry run changes nothing", async t => {
  const ticket = { system: "jira", key: "ABC-7", url: "https://example.atlassian.net/browse/ABC-7", type: "Story" };
  const s = await scenario(t, { ticket });
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const status = await s.check();
  assert.deepEqual(failing(status), [], JSON.stringify(status.checks));
  assert.equal(status.applies, true);
  assert.equal(status.ready, true);
  const plan = status.plan;
  assert.equal(plan.forge, "github");
  assert.equal(plan.repository, "acme/widgets");
  assert.equal(plan.targetBranch, "master");
  assert.equal(plan.taskBranch, branch);
  assert.equal(plan.title, "ABC-7: Add greeting");
  assert.equal(plan.template, ".github/PULL_REQUEST_TEMPLATE.md");
  // The template's text as a model may see it, sent with paseo.json's pull request instructions.
  assert.equal(plan.templateText, "## What changed\n\n## How to test");
  assert.deepEqual(plan.uncommittedFiles, ["greeting.txt"]);
  assert.equal(plan.pushCommit, null);
  assert.equal(plan.body, pullRequestBody({ template: "## What changed\n\n## How to test", summary: "Adds a greeting file.\nCheck greeting.txt.", task: { taskId, ticket } }));
  assert.match(plan.body, /^## What changed[\s\S]*## Summary\n\nAdds a greeting file\.[\s\S]*Ticket: \[ABC-7\]\(https:\/\/example\.atlassian\.net\/browse\/ABC-7\)/);
  assert.deepEqual(plan.commands.map(item => item.step), ["Commit", "Commit", "Push", "Draft pull request"]);
  assert.ok(plan.commands[2].text.endsWith(`push --porcelain --no-follow-tags --recurse-submodules=no origin "<the new commit>:refs/heads/${branch}"`), plan.commands[2].text);
  assert.ok(!plan.commands.some(item => /--force|-f\b|\+refs/.test(item.text)), "never forced");
  assert.equal(plan.commands[3].text, `gh pr create --draft --repo acme/widgets --base master --head ${branch} --title "ABC-7: Add greeting" --body-file "<temporary file with the body above>"`);

  const dry = await s.start(plan.fingerprint, true);
  assert.equal(dry.outcome, "dry-run", JSON.stringify(dry));
  assert.deepEqual(dry.commands, plan.commands);
  assert.ok(dry.notes.some(note => /origin has no .* yet; the push creates it/.test(note)));
  // Nothing changed: no commit, no branch on origin, no pull request, no card.
  assert.equal(s.git(s.worktree, "rev-parse", "HEAD"), s.git(s.repo, "rev-parse", "master"));
  assert.equal(originHas(s, branch), "");
  assert.ok(!(await s.calls()).some(call => call.args[0] === "pr"));
  assert.deepEqual(await s.results.list(), []);
});

test("GitHub: Open PR commits, pushes only the task branch and opens a draft with gh, then records it", async t => {
  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  // Config that would push more than the task branch: an annotated tag on a pushed commit, and followTags.
  s.git(s.repo, "config", "push.followTags", "true");
  s.git(s.repo, "config", "push.recurseSubmodules", "on-demand");
  s.git(s.repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "tag", "-a", "local-only", "-m", "local", "master");
  const branchesBefore = s.git(s.origin, "for-each-ref", "--format=%(refname)");
  const status = await s.check();
  const reply = await s.start(status.plan.fingerprint);
  assert.equal(reply.outcome, "opened", JSON.stringify(reply));
  assert.equal(reply.url, "https://github.com/acme/widgets/pull/42");
  assert.equal(reply.number, 42);
  assert.deepEqual(reply.steps.map(step => [step.label, step.state]), [["Commit", "done"], ["Push", "done"], ["Draft pull request", "done"], ["Record on the task", "done"]]);
  // Only the task branch was pushed, at the commit of the uncommitted work.
  assert.equal(originHas(s, branch), reply.pushed);
  assert.equal(reply.pushed, reply.committed);
  assert.equal(s.git(s.origin, "for-each-ref", "--format=%(refname)"), `${branchesBefore}\nrefs/heads/${branch}`, "only the task branch; no tag");
  assert.equal(s.git(s.origin, "tag", "--list"), "");
  assert.equal(s.git(s.origin, "rev-parse", "master"), s.git(s.repo, "rev-parse", "master"));
  const create = (await s.calls()).find(call => call.args[0] === "pr" && call.args[1] === "create");
  assert.deepEqual(create.args.slice(0, 11), ["pr", "create", "--draft", "--repo", "acme/widgets", "--base", "master", "--head", branch, "--title", "Add greeting"]);
  assert.equal(create.body, status.plan.body);
  // The task records it and is In review; the card stays.
  const task = s.readTask();
  assert.equal(task.status, "in_review");
  assert.deepEqual(task.pullRequest, { forge: "github", url: "https://github.com/acme/widgets/pull/42", number: 42, repository: "acme/widgets", targetBranch: "master", taskBranch: branch, head: reply.pushed, createdAt: "2026-09-27T12:00:00.000Z", worktreeDirectory: s.worktree });
  assert.match(readFileSync(join(s.folder, "status.md"), "utf8"), /- 2026-09-27: In review\. Opened draft pull request #42 \(https:\/\/github\.com\/acme\/widgets\/pull\/42\)/);
  const [card] = (await s.results.list()).map(entry => deliveryResultSchema.parse(entry));
  assert.equal(card.kind, "pull-request");
  assert.equal(card.result.outcome, "opened");
  // It left Ready; a second Open PR is refused.
  assert.deepEqual((await s.merges.ready(serverId)).tasks, []);
  const again = await s.check();
  assert.deepEqual(failing(again), ["pull-request"]);
});

test("the commit message, title and body confirmed in the dialog are what the dry run shows and Open PR uses", async t => {
  const ticket = { system: "jira", key: "ABC-7", url: "https://example.atlassian.net/browse/ABC-7", type: "Story" };
  const s = await scenario(t, { ticket });
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const status = await s.check();
  const text = { commitMessage: "feat(greeting): add a greeting file\n\nWritten from paseo.json.", title: "ABC-7 feat: add a greeting", body: "## Why\n\nPeople like greetings.\n\nOpened as a draft by Mission Control." };

  const dry = await s.start(status.plan.fingerprint, true, text);
  assert.equal(dry.outcome, "dry-run", JSON.stringify(dry));
  assert.ok(dry.commands[1].text.endsWith(`commit --quiet -m "${text.commitMessage}"`), dry.commands[1].text);
  assert.match(dry.commands[3].text, /--title "ABC-7 feat: add a greeting"/);
  assert.notDeepEqual(dry.commands, status.plan.commands, "not the default text's commands");
  // The dry run committed nothing.
  assert.equal(s.git(s.worktree, "rev-parse", "HEAD"), s.git(s.repo, "rev-parse", "master"));

  const reply = await s.start(status.plan.fingerprint, false, text);
  assert.equal(reply.outcome, "opened", JSON.stringify(reply));
  assert.equal(s.git(s.repo, "log", "-1", "--format=%B", reply.committed), text.commitMessage);
  const create = (await s.calls()).find(call => call.args[0] === "pr" && call.args[1] === "create");
  assert.equal(create.args[create.args.indexOf("--title") + 1], text.title);
  assert.equal(create.body, text.body);
});

test("Azure DevOps: az opens the draft with the ticket's work item linked", async t => {
  const ticket = { system: "azure-devops", key: "1234", url: "https://dev.azure.com/contoso/Web%20Shop/_workitems/edit/1234", type: "Bug" };
  const s = await scenario(t, { remote: "https://dev.azure.com/contoso/Web%20Shop/_git/api", ticket });
  await s.git(s.worktree, "config", "user.name", "Test");
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  s.git(s.worktree, "add", "greeting.txt");
  s.git(s.worktree, "-c", "user.email=test@example.com", "commit", "-q", "-m", "Add greeting");
  await s.review();
  const status = await s.check();
  assert.deepEqual(failing(status), [], JSON.stringify(status.checks));
  assert.equal(status.plan.forge, "azure-devops");
  assert.equal(status.plan.workItem, "1234");
  assert.equal(status.plan.pushCommit, s.git(s.worktree, "rev-parse", "HEAD"));
  assert.match(detail(status, "tool"), /azure-devops 1\.0\.1; signed in to https:\/\/dev\.azure\.com\/contoso\./);
  const reply = await s.start(status.plan.fingerprint);
  assert.equal(reply.outcome, "opened", JSON.stringify(reply));
  assert.equal(reply.url, "https://dev.azure.com/contoso/Web%20Shop/_git/api/pullrequest/77");
  assert.equal(reply.committed, null);
  const create = (await s.calls()).find(call => call.args[0] === "repos" && call.args[2] === "create");
  const flag = name => create.args[create.args.indexOf(name) + 1];
  assert.equal(flag("--draft"), "true");
  assert.equal(flag("--organization"), "https://dev.azure.com/contoso");
  assert.equal(flag("--project"), "Web Shop");
  assert.equal(flag("--repository"), "api");
  assert.equal(flag("--source-branch"), branch);
  assert.equal(flag("--target-branch"), "master");
  assert.equal(flag("--work-items"), "1234");
  assert.equal(flag("--title"), "1234: Add greeting");
  assert.equal(create.body, status.plan.body);
  assert.equal(originHas(s, branch), reply.pushed);
});

test("Bitbucket Cloud: a POST with draft true opens it, and the credential never appears", async t => {
  const s = await scenario(t, { remote: "git@bitbucket.org:team/app.git" });
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const status = await s.check();
  assert.deepEqual(failing(status), [], JSON.stringify(status.checks));
  assert.match(status.plan.commands.at(-1).text, /^POST http:\/\/127\.0\.0\.1:\d+\/2\.0\/repositories\/team\/app\/pullrequests\nAuthorization: \(from the BITBUCKET_TOKEN environment variable, not shown\)/);
  const reply = await s.start(status.plan.fingerprint);
  assert.equal(reply.outcome, "opened", JSON.stringify(reply));
  assert.equal(reply.url, "https://bitbucket.org/team/app/pull-requests/5");
  const [request] = s.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/2.0/repositories/team/app/pullrequests");
  assert.equal(request.authorization, `Bearer ${token}`);
  assert.deepEqual(request.body, { title: "Add greeting", description: status.plan.body, source: { branch: { name: branch } }, destination: { branch: { name: "master" } }, draft: true, close_source_branch: false });
  // The token is in no plan, result, card, task file or status line.
  const everything = JSON.stringify([status, reply, await s.results.list(), readFileSync(join(s.folder, "task.md"), "utf8"), readFileSync(join(s.folder, "status.md"), "utf8"), readFileSync(join(s.base, "delivery-results.json"), "utf8")]);
  assert.equal(everything.includes(token), false);
  assert.equal(everything.includes(token.slice(4, 20)), false);
});

test("PR states map to draft, open, merged and closed, and are read on demand", async t => {
  for (const [forge, value, state] of [
    ["github", { state: "OPEN", isDraft: true }, "draft"], ["github", { state: "OPEN", isDraft: false }, "open"], ["github", { state: "MERGED" }, "merged"], ["github", { state: "CLOSED" }, "closed"],
    ["azure-devops", { status: "active", isDraft: true }, "draft"], ["azure-devops", { status: "active", isDraft: false }, "open"], ["azure-devops", { status: "completed" }, "merged"], ["azure-devops", { status: "abandoned" }, "closed"],
    ["bitbucket", { state: "OPEN", draft: true }, "draft"], ["bitbucket", { state: "OPEN" }, "open"], ["bitbucket", { state: "MERGED" }, "merged"], ["bitbucket", { state: "DECLINED" }, "closed"], ["bitbucket", { state: "SUPERSEDED" }, "closed"],
    ["github", { state: "WEIRD" }, null],
  ]) assert.equal(mapState(forge, value), state, `${forge} ${JSON.stringify(value)}`);

  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  assert.equal((await s.start((await s.check()).plan.fingerprint)).outcome, "opened");
  // Without read, the last state (none yet) is returned and gh isn't asked.
  const viewsBefore = (await s.calls()).filter(call => call.args[1] === "view").length;
  assert.equal((await s.list(false))[0].state, null);
  assert.equal((await s.calls()).filter(call => call.args[1] === "view").length, viewsBefore);
  assert.equal((await s.list())[0].state, "draft");
  s.tools["gh pr view"] = { stdout: JSON.stringify({ state: "OPEN", isDraft: false }) };
  await s.saveTools();
  assert.equal((await s.list())[0].state, "open");
  const view = (await s.calls()).find(call => call.args[1] === "view");
  assert.deepEqual(view.args, ["pr", "view", "42", "--repo", "acme/widgets", "--json", "state,isDraft,headRefOid"]);
});

test("a merged pull request offers Clean up, which archives the workspace, deletes the branch and marks the task delivered", async t => {
  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const opened = await s.start((await s.check()).plan.fingerprint);
  assert.equal(opened.outcome, "opened");
  // Not merged yet: Clean up is refused and changes nothing.
  assert.match((await s.service.cleanupPlan({ serverId, taskId }, s.paseo)).reason, /draft, not merged/);
  const early = await s.cleanup();
  assert.equal(early.outcome, "refused");
  assert.deepEqual(s.events, []);

  s.tools["gh pr view"] = { stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: opened.pushed }) };
  await s.saveTools();
  assert.equal((await s.list())[0].state, "merged");
  // Cleanup never runs by itself: reading the state changed nothing.
  assert.deepEqual(s.events, []);
  assert.equal(s.readTask().status, "in_review");
  const { plan } = await s.service.cleanupPlan({ serverId, taskId }, s.paseo);
  assert.equal(plan.branchDeletable, true);
  const done = await s.cleanup();
  assert.equal(done.outcome, "cleaned", JSON.stringify(done));
  assert.deepEqual(done.steps.map(step => [step.label, step.state]), [["Clear Review marks", "done"], ["Archive worktree workspace", "done"], ["Delete local branch", "done"], ["Mark delivered", "done"]]);
  assert.deepEqual(s.events, [["marks", "wks_task"], ["archive", "wks_task"]]);
  assert.equal(s.git(s.repo, "branch", "--list", branch), "");
  // origin's branch is left to the forge.
  assert.equal(originHas(s, branch), opened.pushed);
  assert.equal(s.readTask().status, "delivered");
  assert.match(readFileSync(join(s.folder, "status.md"), "utf8"), /Delivered\. Pull request #42 .* merged into master; Mission Control cleaned up\./);
  assert.deepEqual(await s.list(), []);
  // Each attempt keeps its card: the refused early one, the clean-up and the pull request.
  const kinds = (await s.results.list()).map(entry => entry.kind).sort();
  assert.deepEqual(kinds, ["cleanup", "cleanup", "pull-request"]);
});

test("a closed pull request offers no cleanup, and Clean up refuses a moved branch or uncommitted work", async t => {
  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const opened = await s.start((await s.check()).plan.fingerprint);
  assert.equal(opened.outcome, "opened");
  s.tools["gh pr view"] = { stdout: JSON.stringify({ state: "CLOSED", isDraft: false }) };
  await s.saveTools();
  assert.equal((await s.list())[0].state, "closed");
  const closed = await s.cleanup();
  assert.equal(closed.outcome, "refused");
  assert.match(closed.reason, /closed without merging/);
  assert.deepEqual(s.events, []);

  // Merged, but the worktree has uncommitted work the pull request doesn't hold: refused, nothing changes.
  s.tools["gh pr view"] = { stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: opened.pushed }) };
  await s.saveTools();
  await writeFile(join(s.worktree, "draft.txt"), "not committed\n");
  const dirty = await s.cleanup();
  assert.equal(dirty.outcome, "refused", JSON.stringify(dirty));
  assert.match(dirty.reason, /has 1 uncommitted change .* Nothing was archived or marked delivered/);
  assert.match((await s.service.cleanupPlan({ serverId, taskId }, s.paseo)).reason, /uncommitted change/);
  await rm(join(s.worktree, "draft.txt"));

  // Merged, but the local branch has a commit the pull request's final head doesn't: refused, nothing changes.
  await writeFile(join(s.worktree, "later.txt"), "later\n");
  s.git(s.worktree, "add", "later.txt");
  s.git(s.worktree, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "later");
  const later = s.git(s.worktree, "rev-parse", "HEAD");
  const moved = await s.cleanup();
  assert.equal(moved.outcome, "refused", JSON.stringify(moved));
  assert.match(moved.reason, /has 1 commit that the merged pull request's final commit .* doesn't, so cleaning up would lose that work\. Deliver or remove those commits first\. Nothing was archived or marked delivered\./);
  assert.deepEqual(s.events, [], "no marks cleared, no workspace archived");
  assert.equal(s.git(s.repo, "rev-parse", branch), later);
  assert.equal(s.readTask().status, "in_review");
  assert.equal(existsSync(s.worktree), true);
});

test("Open PR refuses: Merge projects, unknown forges, missing or signed-out tools, open decisions and busy agents", async t => {
  const merge = await scenario(t, { mode: "merge" });
  await writeFile(join(merge.worktree, "greeting.txt"), "hello\n");
  await merge.review();
  const mergeStatus = await merge.check();
  assert.equal(mergeStatus.applies, false);
  assert.deepEqual(failing(mergeStatus), ["delivery"]);
  assert.equal((await merge.merges.ready(serverId)).tasks[0].delivery, "merge");

  const gitlab = await scenario(t, { remote: "https://gitlab.com/acme/widgets.git" });
  await writeFile(join(gitlab.worktree, "greeting.txt"), "hello\n");
  await gitlab.review();
  const gitlabStatus = await gitlab.check();
  assert.deepEqual(failing(gitlabStatus), ["forge"]);
  assert.match(detail(gitlabStatus, "forge"), /isn't a known GitHub, Azure DevOps or Bitbucket Cloud address\. Map its host, or set this project's forge/);

  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  s.setGh(null);
  assert.match(detail(await s.check(), "tool"), /gh \(GitHub CLI\) isn't installed/);
  const signedOut = await scenario(t);
  await writeFile(join(signedOut.worktree, "greeting.txt"), "hello\n");
  await signedOut.review();
  signedOut.tools["gh auth"] = { code: 1, stderr: "You are not logged into any GitHub hosts. Run gh auth login to authenticate." };
  await signedOut.saveTools();
  const signedOutStatus = await signedOut.check();
  assert.deepEqual(failing(signedOutStatus), ["tool"]);
  assert.match(detail(signedOutStatus, "tool"), /Not signed in to github\.com\. Run: gh auth login/);
  // A stale plan confirmed before the sign-out is refused when run: the tool is asked again.
  const refused = await signedOut.start(signedOutStatus.plan.fingerprint);
  assert.equal(refused.outcome, "refused");

  const noCredentials = await scenario(t, { remote: "https://bitbucket.org/team/app.git" });
  noCredentials.setBitbucketAuth(async () => null);
  await writeFile(join(noCredentials.worktree, "greeting.txt"), "hello\n");
  await noCredentials.review();
  assert.match(detail(await noCredentials.check(), "tool"), /No Bitbucket credentials: set BITBUCKET_TOKEN/);

  const open = await scenario(t);
  await writeFile(join(open.worktree, "greeting.txt"), "hello\n");
  await open.review("open");
  assert.ok(failing(await open.check()).includes("review"));

  const busy = await scenario(t, { agentStatus: "running" });
  await writeFile(join(busy.worktree, "greeting.txt"), "hello\n");
  await busy.review();
  assert.deepEqual(failing(await busy.check()), ["agent"]);

  const nothing = await scenario(t);
  await nothing.review();
  assert.deepEqual(failing(await nothing.check()), ["work"]);
  assert.deepEqual(await nothing.calls().then(calls => calls.filter(call => call.args[0] === "pr")), []);
});

test("Open PR refuses a changed task, and a branch on origin that would need a force-push", async t => {
  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const confirmed = await s.check();
  // The files changed after the confirmation (and after the review).
  await writeFile(join(s.worktree, "greeting.txt"), "hello again\n");
  const changed = await s.start(confirmed.plan.fingerprint);
  assert.equal(changed.outcome, "refused");
  assert.match(changed.reason, /changed after its review was requested/);

  const diverged = await scenario(t);
  await writeFile(join(diverged.worktree, "greeting.txt"), "hello\n");
  await diverged.review();
  // Someone else pushed a different commit to origin's task branch.
  const other = join(diverged.base, "other");
  execFileSync("git", ["clone", "-q", diverged.origin, other]);
  execFileSync("git", ["-C", other, "checkout", "-q", "-b", branch]);
  await writeFile(join(other, "theirs.txt"), "theirs\n");
  execFileSync("git", ["-C", other, "add", "."]);
  execFileSync("git", ["-C", other, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "theirs"]);
  execFileSync("git", ["-C", other, "push", "-q", "origin", branch]);
  const theirs = execFileSync("git", ["-C", other, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const head = diverged.git(diverged.worktree, "rev-parse", "HEAD");
  const status = await diverged.check();
  assert.deepEqual(failing(status), []);
  const dry = await diverged.start(status.plan.fingerprint, true);
  assert.equal(dry.outcome, "refused");
  assert.match(dry.reason, /would need a force-push\. Mission Control never force-pushes/);
  const reply = await diverged.start(status.plan.fingerprint);
  assert.equal(reply.outcome, "refused");
  assert.match(reply.reason, /would need a force-push/);
  // Nothing changed: no commit here, origin's branch is still theirs.
  assert.equal(diverged.git(diverged.worktree, "rev-parse", "HEAD"), head);
  assert.equal(originHas(diverged, branch), theirs);
});

test("a rejected push or a failed gh keeps the commit, reports each step and hides token-like output", async t => {
  const s = await scenario(t);
  // origin's pre-receive hook rejects every push.
  const hook = join(s.origin, "hooks", "pre-receive");
  await writeFile(hook, "#!/bin/sh\necho 'rejected by policy' >&2\nexit 1\n");
  await chmod(hook, 0o755);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const rejected = await s.start((await s.check()).plan.fingerprint);
  assert.equal(rejected.outcome, "failed", JSON.stringify(rejected));
  assert.match(rejected.reason, /wasn't pushed, so no pull request was opened\. The task's uncommitted work stays committed/);
  assert.deepEqual(rejected.steps.map(step => [step.label, step.state]), [["Commit", "done"], ["Push", "failed"]]);
  assert.match(rejected.steps[1].detail, /rejected by policy[\s\S]*Nothing was forced/);
  assert.equal(originHas(s, branch), "");
  assert.equal(s.readTask().status, "in_progress");

  // The hook is gone; gh now fails with a token in its message. The earlier commit counts as reviewed.
  await rm(hook);
  s.tools["gh pr create"] = { code: 1, stderr: "HTTP 401: Bad credentials (token ghp_Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78)" };
  await s.saveTools();
  const status = await s.check();
  assert.deepEqual(failing(status), [], JSON.stringify(status.checks));
  const failed = await s.start(status.plan.fingerprint);
  assert.equal(failed.outcome, "failed", JSON.stringify(failed));
  assert.equal(failed.pushed, rejected.committed);
  assert.deepEqual(failed.steps.map(step => [step.label, step.state]), [["Push", "done"], ["Draft pull request", "failed"]]);
  assert.match(failed.steps[1].detail, /Bad credentials \(token \[key hidden\]\)/);
  assert.equal(JSON.stringify(await s.results.list()).includes("ghp_Ab12"), false);
  assert.equal(s.readTask().pullRequest, undefined);
});

test("workItemOf reads an Azure DevOps ticket's number, and the body works without a template or handoff", () => {
  assert.equal(workItemOf({ ticket: { system: "azure-devops", key: "#88", url: "https://dev.azure.com/c/p/_workitems/edit/88" } }), "88");
  assert.equal(workItemOf({ ticket: { system: "azure-devops", key: "Bug 88", url: "https://dev.azure.com/c/p/_workitems/edit/88" } }), "88");
  assert.equal(workItemOf({ ticket: { system: "jira", key: "ABC-1", url: "https://x/browse/ABC-1" } }), null);
  assert.equal(pullRequestBody({ template: null, summary: null, task: { taskId } }), `Opened as a draft by Mission Control for task ${taskId}.`);
});

test("unreadable Delivery settings make Open PR step aside for Merge, and Merge keeps working with a warning", async t => {
  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  s.settings.projects = null;
  const status = await s.check();
  assert.equal(status.applies, false);
  assert.match(detail(status, "delivery"), /Delivery settings can't be read .* offered Merge/);
  const { tasks, warning } = await s.merges.ready(serverId);
  assert.equal(tasks[0].delivery, "merge");
  assert.match(warning, /Delivery settings can't be read/);
  const merge = await s.merges.check({ serverId, taskId }, s.paseo);
  assert.ok(merge.checks.find(item => item.id === "task").ok, JSON.stringify(merge.checks));
});

test("tool errors hide URL credentials and legacy Azure DevOps tokens", () => {
  const { toolError, bitbucketError } = require("./forge-tools.ts");
  const pat = "k2x7mq4w5b3c5v6n2z2p4r6t3y3u5i7o5a2s4d6f4g3h5j7l2q4w";
  const text = toolError({ code: 1, stdout: "", stderr: `fatal: unable to access 'https://me:${pat}@dev.azure.com/contoso/p/_git/api/': 401\nPAT ${pat} rejected` }, "failed");
  assert.equal(text.includes(pat), false, text);
  assert.equal(text.includes("me:"), false, text);
  assert.match(text, /https:\/\/dev\.azure\.com\/contoso\/p\/_git\/api\//);
  const bitbucket = bitbucketError({ status: 401, text: JSON.stringify({ error: { message: "Bad token for https://user:secretvalue@bitbucket.org/team/app" } }) });
  assert.equal(bitbucket.includes("secretvalue"), false, bitbucket);
});

test("Clean up allows review fixes pushed to the pull request, comparing with its final head from the forge", async t => {
  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const opened = await s.start((await s.check()).plan.fingerprint);
  assert.equal(opened.outcome, "opened");
  // A review fix, committed in the worktree and pushed to the pull request's branch before it merged.
  await writeFile(join(s.worktree, "greeting.txt"), "hello, reviewed\n");
  s.git(s.worktree, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-am", "review fix");
  s.git(s.worktree, "push", "-q", "origin", branch);
  const fixed = s.git(s.worktree, "rev-parse", "HEAD");
  assert.notEqual(fixed, opened.pushed);
  // The forge reports the fix as the final head; the recorded head is still the first push.
  s.tools["gh pr view"] = { stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: fixed }) };
  await s.saveTools();
  assert.equal(s.readTask().pullRequest.head, opened.pushed);
  const { plan, reason } = await s.service.cleanupPlan({ serverId, taskId }, s.paseo);
  assert.equal(reason, null);
  assert.equal(plan.branchDeletable, true);
  const done = await s.cleanup();
  assert.equal(done.outcome, "cleaned", JSON.stringify(done));
  assert.match(done.steps.find(step => step.label === "Delete local branch").detail, /the pull request's final commit .* contains it/);
  assert.equal(s.git(s.repo, "branch", "--list", branch), "");
  assert.equal(s.readTask().status, "delivered");
  // gh was asked for the head commit.
  assert.ok((await s.calls()).some(call => call.args[1] === "view" && call.args.includes("state,isDraft,headRefOid")));
});

test("Clean up finishes after a squash merge that deleted the branch, when the final head exists only on the forge", async t => {
  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const opened = await s.start((await s.check()).plan.fingerprint);
  assert.equal(opened.outcome, "opened");
  // GitHub's Update branch made the final head on the forge; the branch was then squash-merged and deleted there.
  const forgeOnly = "0123456789abcdef0123456789abcdef01234567";
  s.git(s.origin, "branch", "-D", branch);
  s.tools["gh pr view"] = { stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: forgeOnly, commits: [{ oid: opened.pushed }, { oid: forgeOnly }] }) };
  await s.saveTools();
  const done = await s.cleanup();
  assert.equal(done.outcome, "cleaned", JSON.stringify(done));
  assert.match(done.steps.find(step => step.label === "Delete local branch").detail, /all 1 commit of its own are in the merged pull request/);
  assert.equal(s.git(s.repo, "branch", "--list", branch), "");
  assert.equal(s.readTask().status, "delivered");
  assert.ok((await s.calls()).some(call => call.args[1] === "view" && call.args.at(-1) === "commits"), "the pull request's commits were read from the forge");
});

test("Clean up keeps local work the merged pull request didn't contain, and refuses when that can't be checked", async t => {
  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const opened = await s.start((await s.check()).plan.fingerprint);
  assert.equal(opened.outcome, "opened");
  // A local commit made after the push, which never reached the pull request.
  await writeFile(join(s.worktree, "later.txt"), "later\n");
  s.git(s.worktree, "add", "later.txt");
  s.git(s.worktree, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "later");
  const later = s.git(s.worktree, "rev-parse", "HEAD");
  s.tools["gh pr view"] = { stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: "0123456789abcdef0123456789abcdef01234567", commits: [{ oid: opened.pushed }] }) };
  await s.saveTools();
  const kept = await s.cleanup();
  assert.equal(kept.outcome, "refused", JSON.stringify(kept));
  assert.match(kept.reason, new RegExp(`has 1 commit the merged pull request didn't contain \\(${later.slice(0, 7)}\\), so cleaning up would lose that work\\. Deliver or remove those commits first\\. Nothing was archived or marked delivered\\.`));
  // The forge lists none of the branch's commits (an empty list): refused, nothing changes.
  s.tools["gh pr view"] = { stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: "0123456789abcdef0123456789abcdef01234567" }) };
  await s.saveTools();
  const noList = await s.cleanup();
  assert.equal(noList.outcome, "refused");
  assert.match(noList.reason, /has 2 commits the merged pull request didn't contain/, "an empty list contains none of them");
  assert.deepEqual(s.events, []);
  assert.equal(s.git(s.repo, "rev-parse", branch), later);
  assert.equal(s.readTask().status, "in_review");
});

test("Clean up finishes when the local branch is already gone, but still refuses uncommitted work in the recorded worktree", async t => {
  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const opened = await s.start((await s.check()).plan.fingerprint);
  assert.equal(opened.outcome, "opened");
  assert.equal(s.readTask().pullRequest.worktreeDirectory, s.worktree);
  // The worktree left the branch (detached) and the branch was deleted by hand; the worktree has an uncommitted file.
  s.git(s.worktree, "checkout", "-q", "--detach");
  s.git(s.repo, "branch", "-D", branch);
  await writeFile(join(s.worktree, "draft.txt"), "not committed\n");
  s.tools["gh pr view"] = { stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: opened.pushed }) };
  await s.saveTools();
  const dirty = await s.cleanup();
  assert.equal(dirty.outcome, "refused", JSON.stringify(dirty));
  assert.match(dirty.reason, /has 1 uncommitted change/);
  await rm(join(s.worktree, "draft.txt"));
  const done = await s.cleanup();
  assert.equal(done.outcome, "cleaned", JSON.stringify(done));
  assert.deepEqual(done.steps.map(step => [step.label, step.state]), [["Clear Review marks", "done"], ["Archive worktree workspace", "done"], ["Delete local branch", "done"], ["Mark delivered", "done"]]);
  assert.match(done.steps.find(step => step.label === "Delete local branch").detail, /already deleted|already gone/);
  assert.equal(s.readTask().status, "delivered");
});

test("Azure DevOps and Bitbucket give the pull request's commits too, for a head that exists only on the forge", async t => {
  const forgeOnly = "0123456789abcdef0123456789abcdef01234567";
  const ado = await scenario(t, { remote: "https://dev.azure.com/contoso/Web%20Shop/_git/api" });
  await writeFile(join(ado.worktree, "greeting.txt"), "hello\n");
  await ado.review();
  const adoOpened = await ado.start((await ado.check()).plan.fingerprint);
  assert.equal(adoOpened.outcome, "opened", JSON.stringify(adoOpened));
  ado.tools["az repos pr"] = { stdout: JSON.stringify({ pullRequestId: 77, status: "completed", isDraft: false, lastMergeSourceCommit: { commitId: forgeOnly } }) };
  // The list can't be read: refused, and nothing changes.
  ado.tools["az devops invoke"] = { code: 1, stderr: "TF401019: The Git repository could not be found." };
  await ado.saveTools();
  const unread = await ado.cleanup();
  assert.equal(unread.outcome, "refused", JSON.stringify(unread));
  assert.match(unread.reason, /its list of commits couldn't be read from Azure DevOps \(TF401019.*\), so Mission Control can't tell .* Nothing was archived or marked delivered\./);
  assert.deepEqual(ado.events, []);
  ado.tools["az devops invoke"] = { stdout: JSON.stringify({ value: [{ commitId: adoOpened.pushed }, { commitId: forgeOnly }] }) };
  await ado.saveTools();
  const adoDone = await ado.cleanup();
  assert.equal(adoDone.outcome, "cleaned", JSON.stringify(adoDone));
  const invoke = (await ado.calls()).find(call => call.args[0] === "devops" && call.args[1] === "invoke");
  const flag = name => invoke.args[invoke.args.indexOf(name) + 1];
  assert.deepEqual([flag("--area"), flag("--resource"), flag("--organization")], ["git", "pullRequestCommits", "https://dev.azure.com/contoso"]);
  assert.deepEqual(invoke.args.filter(arg => /^(project|repositoryId|pullRequestId)=/.test(arg)), ["project=Web Shop", "repositoryId=api", "pullRequestId=77"]);

  const bb = await scenario(t, { remote: "git@bitbucket.org:team/app.git" });
  await writeFile(join(bb.worktree, "greeting.txt"), "hello\n");
  await bb.review();
  const bbOpened = await bb.start((await bb.check()).plan.fingerprint);
  assert.equal(bbOpened.outcome, "opened", JSON.stringify(bbOpened));
  bb.bitbucket.view = { status: 200, body: { id: 5, state: "MERGED", draft: false, source: { commit: { hash: forgeOnly.slice(0, 12) } } } };
  bb.bitbucket.commits = [{ status: 200, body: { values: [{ hash: forgeOnly }], next: "NEXT" } }, { status: 200, body: { values: [{ hash: bbOpened.pushed }] } }];
  const bbDone = await bb.cleanup();
  assert.equal(bbDone.outcome, "cleaned", JSON.stringify(bbDone));
  const pages = bb.requests.filter(request => request.url.includes("/commits"));
  assert.deepEqual(pages.map(request => request.url.includes("page=2")), [false, true, false, true], "both pages, read before and again under the repository lock");
  assert.ok(pages.every(request => request.authorization === `Bearer ${token}`));
});

test("az devops login counts as signed in, and an Azure DevOps Server is told to use it", async t => {
  const server = await scenario(t, { remote: "http://tfs.corp:8080/tfs/DefaultCollection/Web/_git/api" });
  server.settings.forgeHosts = [{ match: "tfs.corp", forge: "azure-devops", host: "" }];
  await writeFile(join(server.worktree, "greeting.txt"), "hello\n");
  await server.review();
  // Not signed in with az login, but az devops login's token works for the organization.
  server.tools["az account show"] = { code: 1, stderr: "Please run 'az login' to setup account." };
  await server.saveTools();
  const signed = await server.check();
  assert.deepEqual(failing(signed), [], JSON.stringify(signed.checks));
  assert.match(detail(signed, "tool"), /signed in to http:\/\/tfs\.corp:8080\/tfs\/DefaultCollection/);
  const asked = (await server.calls()).find(call => call.args[0] === "devops" && call.args[1] === "project");
  assert.equal(asked.args[asked.args.indexOf("--organization") + 1], "http://tfs.corp:8080/tfs/DefaultCollection");
  // Neither works: the advice is az devops login for a Server, not az login.
  const out = await scenario(t, { remote: "http://tfs.corp:8080/tfs/DefaultCollection/Web/_git/api" });
  out.settings.forgeHosts = [{ match: "tfs.corp", forge: "azure-devops", host: "" }];
  out.tools["az account show"] = { code: 1, stderr: "Please run 'az login' to setup account." };
  out.tools["az devops project"] = { code: 1, stderr: "TF400813: The user is not authorized." };
  await out.saveTools();
  await writeFile(join(out.worktree, "greeting.txt"), "hello\n");
  await out.review();
  const status = await out.check();
  assert.deepEqual(failing(status), ["tool"]);
  assert.match(detail(status, "tool"), /not signed in to http:\/\/tfs\.corp:8080\/tfs\/DefaultCollection\. Run: az devops login --organization http:\/\/tfs\.corp:8080\/tfs\/DefaultCollection \(Azure DevOps Server needs a personal access token\)/);
  // The pull request opened on a Server records its organization URL with the scheme and port.
  const opened = await server.start(signed.plan.fingerprint);
  assert.equal(opened.outcome, "opened", JSON.stringify(opened));
  assert.equal(opened.url, "http://tfs.corp:8080/tfs/DefaultCollection/Web/_git/api/pullrequest/77");
  assert.equal(server.readTask().pullRequest.organizationUrl, "http://tfs.corp:8080/tfs/DefaultCollection");
});

test("Open PR uses custom hosts and a project's forge override: an SSH alias, GitHub Enterprise and Azure DevOps Server", async t => {
  // An SSH alias of github.com (Host github-work in ~/.ssh/config).
  const alias = await scenario(t, { remote: "git@github-work:acme/widgets.git" });
  await writeFile(join(alias.worktree, "greeting.txt"), "hello\n");
  await alias.review();
  assert.deepEqual(failing(await alias.check()), ["forge"], "unknown until the host is mapped");
  alias.settings.forgeHosts = [{ match: "github-work", forge: "github", host: "" }];
  const aliased = await alias.check();
  assert.deepEqual(failing(aliased), [], JSON.stringify(aliased.checks));
  assert.match(detail(aliased, "forge"), /GitHub: acme\/widgets \(custom host\)/);
  const opened = await alias.start(aliased.plan.fingerprint);
  assert.equal(opened.outcome, "opened", JSON.stringify(opened));
  const create = (await alias.calls()).find(call => call.args[1] === "create");
  assert.equal(create.args[create.args.indexOf("--repo") + 1], "acme/widgets");
  assert.equal(originHas(alias, branch), opened.pushed, "the push went through the alias's pushInsteadOf");

  // GitHub Enterprise: gh is asked about that host, and --repo names it.
  const enterprise = await scenario(t, { remote: "https://github.example.com/acme/widgets.git" });
  enterprise.settings.forgeHosts = [{ match: "github.example.com", forge: "github", host: "" }];
  await writeFile(join(enterprise.worktree, "greeting.txt"), "hello\n");
  await enterprise.review();
  const ghe = await enterprise.check();
  assert.deepEqual(failing(ghe), [], JSON.stringify(ghe.checks));
  assert.equal(ghe.plan.repository, "github.example.com/acme/widgets");
  assert.match(detail(ghe, "tool"), /Signed in to github\.example\.com/);
  assert.ok((await enterprise.calls()).some(call => call.args.join(" ") === "auth status --hostname github.example.com"));

  // An unknown host, set per project to Azure DevOps: an Azure DevOps Server collection.
  const server = await scenario(t, { remote: "https://tfs.corp.example/tfs/DefaultCollection/Web/_git/api" });
  await writeFile(join(server.worktree, "greeting.txt"), "hello\n");
  await server.review();
  assert.match(detail(await server.check(), "forge"), /Map its host, or set this project's forge, in Settings → Delivery/);
  server.settings.projects = { prj_work: { forge: "azure-devops" } };
  const overridden = await server.check();
  assert.deepEqual(failing(overridden), [], JSON.stringify(overridden.checks));
  assert.match(detail(overridden, "forge"), /Azure DevOps: DefaultCollection\/Web\/api \(project override\)/);
  const reply = await server.start(overridden.plan.fingerprint);
  assert.equal(reply.outcome, "opened", JSON.stringify(reply));
  const azCreate = (await server.calls()).find(call => call.args[0] === "repos" && call.args[2] === "create");
  assert.equal(azCreate.args[azCreate.args.indexOf("--organization") + 1], "https://tfs.corp.example/tfs/DefaultCollection");
  assert.equal(server.readTask().pullRequest.organizationUrl, "https://tfs.corp.example/tfs/DefaultCollection");
  // Reading its state later uses the recorded organization URL.
  await server.list();
  const show = (await server.calls()).find(call => call.args[0] === "repos" && call.args[2] === "show");
  assert.equal(show.args[show.args.indexOf("--organization") + 1], "https://tfs.corp.example/tfs/DefaultCollection");
});

test("Clean up keeps the branch when a commit lands on it after the check, and deletes only the commit it checked", async t => {
  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const opened = await s.start((await s.check()).plan.fingerprint);
  assert.equal(opened.outcome, "opened");
  s.tools["gh pr view"] = { stdout: JSON.stringify({ state: "MERGED", isDraft: false, headRefOid: opened.pushed }) };
  await s.saveTools();
  // While the workspace is archived (after the check under the lock), a commit lands on the task branch.
  const archive = s.paseo.workspaces.ref;
  let late = "";
  s.paseo.workspaces.ref = id => ({
    archive: async () => {
      const tree = s.git(s.repo, "rev-parse", `${opened.pushed}^{tree}`);
      late = execFileSync("git", ["-C", s.repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit-tree", tree, "-p", opened.pushed, "-m", "late"], { encoding: "utf8" }).trim();
      s.git(s.repo, "update-ref", `refs/heads/${branch}`, late);
      return archive(id).archive();
    },
  });
  const done = await s.cleanup();
  assert.equal(done.outcome, "cleaned", JSON.stringify(done));
  const step = done.steps.find(item => item.label === "Delete local branch");
  assert.equal(step.state, "skipped", JSON.stringify(step));
  assert.match(step.detail, /moved to .* after it was checked at .*, so it was kept; nothing on it was deleted\./);
  // The late commit is still on the branch.
  assert.equal(s.git(s.repo, "rev-parse", branch), late);
});
