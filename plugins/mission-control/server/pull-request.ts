import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { pullRequestTitle, type DeliveryMode, type ProjectRemote } from "../shared/delivery";
import { pullRequestFooter, templateForModel } from "../shared/paseo-metadata";
import { detectForge, forgeLabels, forgeSourceLabels, redactRemoteUrl, type ForgeOptions, type ForgeRepository } from "../shared/forges";
import type { MergeStep } from "../shared/merge";
import type {
  CleanupReply, CleanupResult, DeliveryCommand, PullRequestCheck, PullRequestCheckStatus, PullRequestPlan, PullRequestReply, PullRequestResult, PullRequestState, TrackedPullRequest,
} from "../shared/pull-request";
import type { RunRecord } from "../shared/runs";
import { hideCredentials } from "../shared/secret-mask";
import type { PullRequestRecord, TaskRecord } from "../shared/tasks";
import { createDeliveryResults, type DeliveryResults } from "./delivery-results";
import {
  azSignIn, bitbucketAuth, bitbucketError, findAz, findGh, ghSignIn, httpRequest, runTool, toolError,
  type BitbucketAuth, type Env, type Http, type ToolCommand, type ToolRunner,
} from "./forge-tools";
import { commitTaskWork, git, GitStopped, replyWithinMs, type Evaluation, type EvaluateMode } from "./merge";
import { withRepository } from "./project-git";
import { handoffSummary, runRecordsOf } from "./runs";
import type { TaskSource } from "./tasks";
import { parseWorktreeList } from "./worktree";

type Deps = {
  sources: (serverId: string) => Promise<TaskSource[]>;
  // Merge's checks; Open PR runs them without the main-checkout ones.
  evaluate: (serverId: string, taskId: string, paseo: PaseoApi, mode: EvaluateMode) => Promise<Evaluation>;
  // The project's delivery and pull request title template (Settings → Delivery).
  delivery: (projectId: string) => Promise<{ mode: DeliveryMode; titleTemplate: string; forge?: ForgeOptions }>;
  // The project's target branch: its default branch setting, else origin's HEAD (read in `root`).
  targetBranch: (projectId: string, root: string) => Promise<string | null>;
  projectRoot: (projectId: string, paseo: PaseoApi) => Promise<string>;
  // Records the pull request on the task and sets it to in_review; Clean up later marks it delivered.
  record: (source: TaskSource, pullRequest: PullRequestRecord, line: string) => Promise<unknown>;
  deliver: (source: TaskSource, line: string) => Promise<unknown>;
  clearReviewMarks: (workspaceId: string) => Promise<unknown>;
  results?: DeliveryResults;
  runs?: (source: TaskSource, serverId: string) => Promise<RunRecord[]>;
  // The forge tools; tests put fake gh, az and an HTTP server here.
  gh?: () => Promise<ToolCommand | null>;
  az?: () => Promise<ToolCommand | null>;
  runTool?: ToolRunner;
  bitbucketApi?: string;
  bitbucketAuth?: () => Promise<BitbucketAuth | null>;
  http?: Http;
  env?: Env;
  now?: () => Date;
  writeTimeoutMs?: number;
  networkTimeoutMs?: number;
  replyWithinMs?: number;
};

const checkOrder: PullRequestCheck["id"][] = ["delivery", "task", "pull-request", "review", "agent", "in-progress", "work", "forge", "tool"];
const short = (commit: string) => commit.slice(0, 7);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
// Key-like strings and any user name or password in a URL (https://user:token@host) are hidden before text is shown or kept.
const scrub = hideCredentials;
const failure = (error: unknown) => scrub(error instanceof Error ? error.message : String(error));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** An argument as a person would type it: quoted when it has spaces or quotes. */
const quote = (arg: string) => /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replaceAll("\"", "\\\"")}"`;
const commandLine = (label: string, args: readonly string[]) => [label, ...args].map(quote).join(" ");
const bodyFilePlaceholder = "<temporary file with the body above>";

// ---------- the pull request's text ----------

// Where GitHub and Azure DevOps look for a pull request template, in their order; Bitbucket Cloud has none of
// its own, so it uses the common ones. Names match case-insensitively.
function templatePaths(forge: ForgeRepository["forge"], target: string) {
  const github = [".github/pull_request_template.md", "pull_request_template.md", "docs/pull_request_template.md"];
  const azure = [`.azuredevops/pull_request_template/branches/${target}.md`, `.vsts/pull_request_template/branches/${target}.md`, `pull_request_template/branches/${target}.md`,
    ".azuredevops/pull_request_template.md", ".vsts/pull_request_template.md", "docs/pull_request_template.md", "pull_request_template.md"];
  return forge === "azure-devops" ? azure : github;
}

/** The first pull request template in the task's files (tree), with its path, or null. */
async function findTemplate(cwd: string, tree: string, forge: ForgeRepository["forge"], target: string): Promise<{ path: string; text: string } | null> {
  const listed = await git(cwd, ["ls-tree", "-r", "-z", "--name-only", tree, "--", ".github", ".azuredevops", ".vsts", "docs", "pull_request_template", "pull_request_template.md", "PULL_REQUEST_TEMPLATE.md"]);
  if (listed.code !== 0) return null;
  const files = listed.stdout.split("\0").filter(Boolean);
  for (const wanted of templatePaths(forge, target)) {
    const path = files.find(file => file.toLowerCase() === wanted.toLowerCase());
    if (!path) continue;
    const blob = await git(cwd, ["cat-file", "blob", `${tree}:${path}`]);
    if (blob.code === 0 && blob.stdout.trim()) return { path, text: blob.stdout.trim().slice(0, 20_000) };
  }
  return null;
}

/** An Azure DevOps ticket's work item number, for az --work-items; null for other tickets. */
export function workItemOf(task: Pick<TaskRecord, "ticket">): string | null {
  if (task.ticket?.system !== "azure-devops") return null;
  return /^#?(\d+)$/.exec(task.ticket.key.trim())?.[1] ?? /\/_workitems\/edit\/(\d+)/.exec(task.ticket.url)?.[1] ?? null;
}

/**
 * The body when paseo.json has no pull request instructions (or writing from them failed): the repository's
 * template if any, the handoff summary, and the ticket link.
 */
export function pullRequestBody(parts: { template: string | null; summary: string | null; task: Pick<TaskRecord, "taskId" | "ticket"> }) {
  const { template, summary, task } = parts;
  return [template, summary ? `## Summary\n\n${summary}` : null, ...pullRequestFooter(task)].filter(Boolean).join("\n\n");
}

// ---------- forge commands ----------

function ghCreateArgs(repo: Extract<ForgeRepository, { forge: "github" }>, plan: Pick<PullRequestPlan, "targetBranch" | "taskBranch" | "title">, bodyFile: string) {
  return ["pr", "create", "--draft", "--repo", repo.slug, "--base", plan.targetBranch, "--head", plan.taskBranch, "--title", plan.title, "--body-file", bodyFile];
}

function azCreateArgs(repo: Extract<ForgeRepository, { forge: "azure-devops" }>, plan: Pick<PullRequestPlan, "targetBranch" | "taskBranch" | "title" | "workItem">, bodyFile: string) {
  return ["repos", "pr", "create", "--draft", "true", "--detect", "false", "--organization", repo.organizationUrl, "--project", repo.project, "--repository", repo.repo,
    "--source-branch", plan.taskBranch, "--target-branch", plan.targetBranch, "--title", plan.title, "--description", `@${bodyFile}`,
    ...(plan.workItem ? ["--work-items", plan.workItem] : []), "--output", "json"];
}

function bitbucketCreate(api: string, repo: Extract<ForgeRepository, { forge: "bitbucket" }>, plan: Pick<PullRequestPlan, "targetBranch" | "taskBranch" | "title" | "body">) {
  return {
    url: `${api}/repositories/${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.repo)}/pullrequests`,
    body: JSON.stringify({ title: plan.title, description: plan.body, source: { branch: { name: plan.taskBranch } }, destination: { branch: { name: plan.targetBranch } }, draft: true, close_source_branch: false }),
  };
}

// Only the task branch: no tags (push.followTags) and no submodule branches (push.recurseSubmodules), whatever the config says.
const pushArgs = (tip: string, branch: string) => ["push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", "origin", `${tip}:refs/heads/${branch}`];

/** gh's, az's and Bitbucket's pull request states as draft, open, merged or closed. */
export function mapState(forge: ForgeRepository["forge"], value: { state?: unknown; status?: unknown; isDraft?: unknown; draft?: unknown }): PullRequestState | null {
  const draft = value.isDraft === true || value.draft === true;
  const state = String(value.state ?? value.status ?? "").toUpperCase();
  if (forge === "github") return state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : state === "OPEN" ? (draft ? "draft" : "open") : null;
  if (forge === "azure-devops") return state === "COMPLETED" ? "merged" : state === "ABANDONED" ? "closed" : state === "ACTIVE" ? (draft ? "draft" : "open") : null;
  return state === "MERGED" ? "merged" : state === "DECLINED" || state === "SUPERSEDED" ? "closed" : state === "OPEN" ? (draft ? "draft" : "open") : null;
}

type Tools = { gh: ToolCommand | null; az: ToolCommand | null; auth: BitbucketAuth | null };
// commitMessage, title and body: the text the user confirmed; each one left out uses the plan's default.
type OpenInput = { serverId: string; taskId: string; fingerprint: string; dryRun: boolean; commitMessage?: string; title?: string; body?: string };

/**
 * Attention's Open PR action for pull-request projects (Settings → Delivery), and what follows it: reading the
 * pull request's state and, once it merged, Clean up. Open PR runs Merge's checks without the main-checkout
 * ones, commits the task's uncommitted work, pushes only the task branch (never forced), and opens a draft
 * pull request with gh, az or Bitbucket Cloud's API. It never merges a pull request or stores a credential.
 */
export function createPullRequestService(deps: Deps) {
  const readRuns = deps.runs ?? runRecordsOf;
  const results = deps.results ?? createDeliveryResults();
  const run = deps.runTool ?? runTool;
  const env = deps.env ?? process.env;
  const api = (deps.bitbucketApi ?? "https://api.bitbucket.org/2.0").replace(/\/+$/, "");
  const http = deps.http ?? httpRequest;
  const writeTimeout = deps.writeTimeoutMs ?? 120_000;
  const networkTimeout = deps.networkTimeoutMs ?? 120_000;
  const replyWithin = deps.replyWithinMs ?? replyWithinMs;
  const running = new Set<string>();
  const busy = (taskId: string) => running.has(taskId) || results.running(taskId);
  // Tool sign-in answers for the checks, which Attention repeats every 30 s; a run always asks again.
  const toolCache = new Map<string, { at: number; check: PullRequestCheck }>();
  let bitbucketSource: string | null = null;
  // The last state read for each task's pull request.
  const states = new Map<string, { state: PullRequestState | null; head: string | null; checkedAt: string; error: string | null }>();

  const gitIn = async (cwd: string, args: string[], timeout = 60_000) => {
    const result = await git(cwd, args, { timeout });
    if (result.code !== 0) throw new Error(scrub(result.stderr || `git ${args[0]} failed`));
    return result.stdout.trim();
  };

  async function tools(forge: ForgeRepository["forge"]): Promise<Tools> {
    return {
      gh: forge === "github" ? await (deps.gh ?? (() => findGh(env)))() : null,
      az: forge === "azure-devops" ? await (deps.az ?? (() => findAz(env)))() : null,
      auth: forge === "bitbucket" ? await (deps.bitbucketAuth ?? (() => bitbucketAuth(env)))() : null,
    };
  }

  /** Whether the forge's tool is there and signed in; never shows a credential. */
  /** target: gh's host for GitHub, or the organization URL az is asked about for Azure DevOps. */
  async function toolCheck(forge: ForgeRepository["forge"], fresh: boolean, target = "github.com"): Promise<PullRequestCheck> {
    const key = forge === "bitbucket" ? forge : `${forge}:${target}`;
    const cached = toolCache.get(key);
    if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.check;
    const found = await tools(forge);
    let check: PullRequestCheck;
    try {
      if (forge === "github") {
        if (!found.gh) check = { id: "tool", label: "gh signed in", ok: false, detail: "gh (GitHub CLI) isn't installed on this host. Install it (winget install --id GitHub.cli), then run gh auth login." };
        else { const signIn = await ghSignIn(found.gh, run, target); check = { id: "tool", label: "gh signed in", ok: signIn.signedIn, detail: signIn.detail }; }
      } else if (forge === "azure-devops") {
        if (!found.az) check = { id: "tool", label: "az signed in", ok: false, detail: "az (Azure CLI) isn't installed on this host. Install it, add the azure-devops extension, then run az login." };
        else { const signIn = await azSignIn(found.az, env, run, [target]); check = { id: "tool", label: "az signed in", ok: signIn.signedIn, detail: signIn.detail }; }
      } else {
        bitbucketSource = found.auth?.source ?? null;
        check = found.auth
          ? { id: "tool", label: "Bitbucket credentials", ok: true, detail: `Credentials found in ${found.auth.source}.` }
          : { id: "tool", label: "Bitbucket credentials", ok: false, detail: "No Bitbucket credentials: set BITBUCKET_TOKEN, or BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD, for the Paseo daemon, or store a bitbucket.org credential in Git's credential manager." };
      }
    } catch (error) { check = { id: "tool", label: "Forge tool", ok: false, detail: `Couldn't check the forge tool: ${failure(error)}` }; }
    toolCache.set(key, { at: Date.now(), check });
    return check;
  }

  type Checked = { status: PullRequestCheckStatus; source: TaskSource | null; evaluation: Evaluation | null; repo: ForgeRepository | null };

  async function evaluate(serverId: string, taskId: string, paseo: PaseoApi, freshTool = false): Promise<Checked> {
    const checks: PullRequestCheck[] = [];
    const add = (check: PullRequestCheck) => { checks.push(check); return check.ok; };
    const done = (applies: boolean, source: TaskSource | null = null, plan: PullRequestPlan | null = null, evaluation: Evaluation | null = null, repo: ForgeRepository | null = null): Checked => ({
      status: { taskId, applies, ready: plan !== null && checks.every(check => check.ok), checks: checks.sort((a, b) => checkOrder.indexOf(a.id) - checkOrder.indexOf(b.id)), plan },
      source, evaluation, repo,
    });

    const source = (await deps.sources(serverId)).find(item => item.task.taskId === taskId) ?? null;
    const task = source?.task;
    if (!source || !task || !task.assignments.some(item => item.serverId === serverId)) { add({ id: "task", label: "Task", ok: false, detail: "This task isn't on this host." }); return done(false); }
    let delivery;
    try { delivery = await deps.delivery(task.projectId); }
    catch (error) { add({ id: "delivery", label: "Delivery", ok: false, detail: `Delivery settings can't be read (${failure(error)}), so this task is offered Merge until they're fixed in Settings → Delivery.` }); return done(false, source); }
    if (delivery.mode !== "pull-request") { add({ id: "delivery", label: "Delivery", ok: false, detail: "This project delivers by Merge (Settings → Delivery)." }); return done(false, source); }
    add({ id: "delivery", label: "Delivery", ok: true, detail: "This project delivers by draft pull request." });
    if (task.pullRequest) { add({ id: "pull-request", label: "No pull request yet", ok: false, detail: `This task already has the pull request ${task.pullRequest.url}.` }); return done(true, source); }
    if (!task.worktree) { add({ id: "task", label: "Task", ok: false, detail: "This task didn't run in its own worktree, so there is no task branch to push." }); return done(true, source); }

    const root = await realpath(await deps.projectRoot(task.projectId, paseo));
    const target = await deps.targetBranch(task.projectId, root).catch(() => null);
    if (!target) { add({ id: "work", label: "Work to deliver", ok: false, detail: "The target branch is unknown: origin has no default branch here. Set this project's default branch on the Workspaces tab." }); return done(true, source); }

    // Merge's checks, without the main checkout's.
    const evaluation = await deps.evaluate(serverId, taskId, paseo, { kind: "pull-request", targetBranch: target });
    for (const check of evaluation.status.checks) if (check.id !== "main-checkout" && check.id !== "local-files") add({ ...check, id: check.id as PullRequestCheck["id"] });

    // The forge, from origin's URL.
    const main = evaluation.main ?? root;
    const origin = await git(main, ["remote", "get-url", "origin"]);
    const url = origin.code === 0 ? origin.stdout.trim() : "";
    const repo = url ? detectForge(url, delivery.forge ?? {}) : null;
    if (!url) { add({ id: "forge", label: "Forge", ok: false, detail: "This repository has no origin remote to push to." }); return done(true, source, null, evaluation); }
    if (!repo) { add({ id: "forge", label: "Forge", ok: false, detail: `origin (${redactRemoteUrl(url)}) isn't a known GitHub, Azure DevOps or Bitbucket Cloud address. Map its host, or set this project's forge, in Settings → Delivery.` }); return done(true, source, null, evaluation); }
    add({ id: "forge", label: "Forge", ok: true, detail: `${forgeLabels[repo.forge]}: ${repo.slug}${repo.source === "detected" ? "" : ` (${forgeSourceLabels[repo.source]})`}.` });
    add(await toolCheck(repo.forge, freshTool, repo.forge === "github" ? repo.host : repo.forge === "azure-devops" ? repo.organizationUrl : undefined));

    const worktree = task.worktree;
    if (!evaluation.taskHead || !evaluation.tree || !evaluation.taskDirectory) {
      if (evaluation.taskHead && !evaluation.taskDirectory) add({ id: "work", label: "Work to deliver", ok: false, detail: `${worktree.branch} isn't checked out in a worktree, so there is nowhere to commit or push from.` });
      return done(true, source, null, evaluation, repo);
    }

    const runs = await readRuns(source, serverId);
    const template = await findTemplate(main, evaluation.tree, repo.forge, target);
    const summary = await handoffSummary(source, runs[0]);
    const title = pullRequestTitle(delivery.titleTemplate, task);
    const body = pullRequestBody({ template: template?.text ?? null, summary, task });
    const workItem = repo.forge === "azure-devops" ? workItemOf(task) : null;
    const pushCommit = evaluation.dirty ? null : evaluation.taskHead;
    const base = {
      taskTitle: task.title, forge: repo.forge, repository: repo.slug, webUrl: repo.webUrl, remote: redactRemoteUrl(url), targetBranch: target, taskBranch: worktree.branch,
      worktreeDirectory: evaluation.taskDirectory, worktreeWorkspaceId: worktree.workspaceId,
      uncommittedFiles: evaluation.files.slice(0, 50), uncommittedCount: evaluation.files.length, undoneFiles: evaluation.undone.slice(0, 50), undoneCount: evaluation.undone.length,
      commitMessage: evaluation.commitMessage, commitsAhead: evaluation.ahead, pushCommit, title, body, template: template?.path ?? null, templateText: templateForModel(template?.text), workItem,
      fingerprint: sha256(JSON.stringify([evaluation.taskHead, evaluation.tree, target, repo.slug, redactRemoteUrl(url), title, body, workItem])),
    };
    const plan: PullRequestPlan = { ...base, commands: commandsFor(repo, base) };
    return done(true, source, plan, evaluation, repo);
  }

  /** The exact commands and request a run makes with this plan's text; the confirmation and the dry run show them. */
  function commandsFor(repo: ForgeRepository, plan: Omit<PullRequestPlan, "commands">): DeliveryCommand[] {
    const commands: DeliveryCommand[] = [];
    if (plan.uncommittedCount) {
      commands.push({ step: "Commit", text: commandLine("git", ["-C", plan.worktreeDirectory, "add", "-A"]) });
      commands.push({ step: "Commit", text: commandLine("git", ["-C", plan.worktreeDirectory, "commit", "--quiet", "-m", plan.commitMessage]) });
    }
    commands.push({ step: "Push", text: commandLine("git", ["-C", plan.worktreeDirectory, ...pushArgs(plan.pushCommit ?? "<the new commit>", plan.taskBranch)]) });
    if (repo.forge === "github") commands.push({ step: "Draft pull request", text: commandLine("gh", ghCreateArgs(repo, plan, bodyFilePlaceholder)) });
    else if (repo.forge === "azure-devops") commands.push({ step: "Draft pull request", text: commandLine("az", azCreateArgs(repo, plan, bodyFilePlaceholder)) });
    else {
      const request = bitbucketCreate(api, repo, plan);
      commands.push({ step: "Draft pull request", text: `POST ${request.url}\nAuthorization: (from ${bitbucketSource ?? "Bitbucket credentials"}, not shown)\nContent-Type: application/json\n\n${JSON.stringify(JSON.parse(request.body), null, 2)}` });
    }
    return commands;
  }

  async function check(input: { serverId: string; taskId: string }, paseo: PaseoApi): Promise<PullRequestCheckStatus> {
    if (busy(input.taskId)) return { taskId: input.taskId, applies: true, ready: false, checks: [{ id: "task", label: "Task", ok: false, detail: "This task is being delivered now. Attention shows its progress." }], plan: null };
    return (await evaluate(input.serverId, input.taskId, paseo)).status;
  }

  /** Where origin's task branch is: absent, the tip, an ancestor of it (the push fast-forwards), or elsewhere (refused). */
  async function remoteBranch(cwd: string, branch: string, taskHead: string, timeout: number): Promise<{ at: string | null; note: string; refused: string | null }> {
    // Asked where the push goes (a pushurl or pushInsteadOf can differ from the fetch URL).
    const pushUrl = await gitIn(cwd, ["remote", "get-url", "--push", "origin"]);
    if (!pushUrl || pushUrl.startsWith("-")) throw new Error("origin has no usable push URL.");
    const listed = await gitIn(cwd, ["ls-remote", pushUrl, `refs/heads/${branch}`], timeout);
    const at = /^([0-9a-f]{40})\t/m.exec(listed)?.[1] ?? null;
    if (!at) return { at, note: `origin has no ${branch} yet; the push creates it.`, refused: null };
    if (at === taskHead) return { at, note: `origin's ${branch} is already at ${short(at)}.`, refused: null };
    const known = (await git(cwd, ["cat-file", "-e", `${at}^{commit}`])).code === 0;
    if (known && (await git(cwd, ["merge-base", "--is-ancestor", at, taskHead])).code === 0) return { at, note: `origin's ${branch} is at ${short(at)}, which the task branch contains; the push fast-forwards it.`, refused: null };
    return { at, note: "", refused: `origin's ${branch} is at ${short(at)}, which the task branch doesn't contain, so pushing would need a force-push. Mission Control never force-pushes; look at origin's branch first.` };
  }

  // Callers check busy() first, in the same tick, so two deliveries of one task never overlap.
  async function open(input: OpenInput, paseo: PaseoApi, report: (step: string) => void): Promise<PullRequestResult> {
    running.add(input.taskId);
    try {
      const source = (await deps.sources(input.serverId)).find(item => item.task.taskId === input.taskId);
      if (!source) return { outcome: "refused", reason: "This task isn't on this host.", checks: [] };
      const root = await realpath(await deps.projectRoot(source.task.projectId, paseo));
      return await withRepository(root, () => openLocked(input, paseo, report));
    } finally { running.delete(input.taskId); }
  }

  async function openLocked(input: OpenInput, paseo: PaseoApi, report: (step: string) => void): Promise<PullRequestResult> {
    const { status, source, evaluation, repo } = await evaluate(input.serverId, input.taskId, paseo, true);
    const checked = status.plan;
    if (!status.ready || !checked || !source || !evaluation?.tree || !evaluation.taskHead || !repo) return { outcome: "refused", reason: status.checks.find(item => !item.ok)?.detail ?? "The checks didn't pass.", checks: status.checks };
    if (checked.fingerprint !== input.fingerprint) return { outcome: "refused", reason: "The task, its target or the pull request's text changed since you opened this. Check what will happen again.", checks: status.checks };
    // The text the user confirmed (written from paseo.json, or edited); the defaults for any left out.
    const text = { commitMessage: input.commitMessage ?? checked.commitMessage, title: input.title ?? checked.title, body: input.body ?? checked.body };
    const plan: PullRequestPlan = { ...checked, ...text, commands: commandsFor(repo, { ...checked, ...text }) };
    const cwd = plan.worktreeDirectory;
    const found = await tools(repo.forge);

    report("Checking origin's task branch");
    let remote;
    try { remote = await remoteBranch(cwd, plan.taskBranch, evaluation.taskHead, input.dryRun ? 20_000 : networkTimeout); }
    catch (error) { return { outcome: "refused", reason: `Couldn't read origin's ${plan.taskBranch}: ${failure(error)}. Nothing changed.`, checks: status.checks }; }
    if (remote.refused) return { outcome: "refused", reason: `${remote.refused} Nothing changed.`, checks: status.checks };
    if (input.dryRun) {
      return { outcome: "dry-run", commands: plan.commands, notes: [
        remote.note, evaluation.dirty ? `The commit holds ${plural(plan.uncommittedCount, "uncommitted file")}; the push then sends it.` : `Nothing is uncommitted; the push sends ${short(evaluation.taskHead)}.`,
        plan.template ? `The body starts with the repository's template, ${plan.template}.` : "The repository has no pull request template.",
        "Dry run: nothing was committed, pushed or opened.",
      ].filter(Boolean) };
    }

    const steps: MergeStep[] = [];
    // 1. Commit the worktree's uncommitted work on the task branch.
    let committed: string | null = null;
    if (evaluation.dirty) {
      report("Committing the task's uncommitted work");
      const commit = await commitTaskWork(cwd, { message: plan.commitMessage, branch: plan.taskBranch, tree: evaluation.tree, timeoutMs: writeTimeout, nothingDone: "Nothing was pushed." });
      if ("refused" in commit) return { outcome: "refused", reason: commit.refused, checks: status.checks };
      committed = commit.committed;
      steps.push({ label: "Commit", state: "done", detail: `Committed ${plural(plan.uncommittedCount, "file")} on ${plan.taskBranch} as ${short(committed)}.` });
    } else if (evaluation.undone.length) {
      // Git lists changes whose content matches the branch; unstaging them changes no file.
      for (let index = 0; index < evaluation.undone.length; index += 100) {
        await git(cwd, ["reset", "--quiet", "--", ...evaluation.undone.slice(index, index + 100)], { env: { GIT_LITERAL_PATHSPECS: "1" }, timeout: writeTimeout });
      }
    }
    const tip = committed ?? evaluation.taskHead;
    if ((await gitIn(cwd, ["rev-parse", `${tip}^{tree}`])) !== evaluation.tree) {
      return { outcome: "failed", reason: `The commit to push (${short(tip)}) doesn't hold the files that were checked. Nothing was pushed; check again.`, committed, pushed: null, steps };
    }

    // 2. Push the exact checked commit to origin's task branch only; never forced.
    report(`Pushing ${plan.taskBranch}`);
    let pushed: string | null = null;
    try {
      const push = await git(cwd, pushArgs(tip, plan.taskBranch), { timeout: networkTimeout });
      if (push.code === 0) pushed = tip;
      else steps.push({ label: "Push", state: "failed", detail: `origin refused the push: ${scrub(push.stderr || push.stdout.trim() || "git push failed")}. Nothing was forced.` });
    } catch (error) {
      if (!(error instanceof GitStopped)) throw error;
      // Git may still be pushing: whatever origin says now may change, so the push's result is unknown.
      if (!error.confirmed) {
        steps.push({ label: "Push", state: "failed", detail: `The push stopped: ${error.message}. Whether origin's ${plan.taskBranch} was updated is unknown, so no pull request was opened.` });
        return { outcome: "failed", reason: `The push's result is unknown, so no pull request was opened. Check origin's ${plan.taskBranch} before trying again.${committed ? ` The task's uncommitted work stays committed on ${plan.taskBranch} as ${short(committed)}.` : ""}`, committed, pushed: null, steps };
      }
      // The push and everything it started have ended; ask origin where the branch is now.
      const after = await remoteBranch(cwd, plan.taskBranch, tip, 20_000).catch(() => null);
      if (after?.at === tip) pushed = tip;
      else steps.push({ label: "Push", state: "failed", detail: `The push stopped: ${error.message}. origin's ${plan.taskBranch} is ${after?.at ? `at ${short(after.at)}` : after ? "absent" : "unknown"}.` });
    }
    if (!pushed) return { outcome: "failed", reason: `${plan.taskBranch} wasn't pushed, so no pull request was opened.${committed ? ` The task's uncommitted work stays committed on ${plan.taskBranch} as ${short(committed)}.` : ""}`, committed, pushed: null, steps };
    steps.push({ label: "Push", state: "done", detail: `Pushed ${short(pushed)} to origin's ${plan.taskBranch}${remote.at ? "" : " (new branch)"}.` });

    // 3. Open the draft pull request.
    report("Opening the draft pull request");
    let opened: { url: string; number: number } | null = null;
    let problem = "";
    const folder = await mkdtemp(join(tmpdir(), "mission-pr-"));
    try {
      const bodyFile = join(folder, "body.md");
      await writeFile(bodyFile, plan.body);
      if (repo.forge === "github") {
        if (!found.gh) throw new Error("gh isn't installed.");
        const result = await run(found.gh, ghCreateArgs(repo, plan, bodyFile), { cwd, timeoutMs: networkTimeout });
        const url = /https?:\/\/\S+\/pull\/(\d+)/.exec(result.stdout);
        if (result.code === 0 && url) opened = { url: url[0], number: Number(url[1]) };
        else problem = toolError(result, "gh pr create failed");
      } else if (repo.forge === "azure-devops") {
        if (!found.az) throw new Error("az isn't installed.");
        const result = await run(found.az, azCreateArgs(repo, plan, bodyFile), { cwd, timeoutMs: networkTimeout });
        let id = 0;
        try { id = Number(JSON.parse(result.stdout).pullRequestId) || 0; } catch { id = 0; }
        if (result.code === 0 && id > 0) opened = { url: `${repo.webUrl}/pullrequest/${id}`, number: id };
        else problem = toolError(result, "az repos pr create failed");
      } else {
        const auth = found.auth;
        if (!auth) throw new Error("No Bitbucket credentials.");
        const request = bitbucketCreate(api, repo, plan);
        const response = await http({ method: "POST", url: request.url, headers: { Authorization: auth.header, "Content-Type": "application/json", Accept: "application/json" }, body: request.body });
        let id = 0;
        let href = "";
        try { const parsed = JSON.parse(response.text); id = Number(parsed.id) || 0; href = String(parsed.links?.html?.href ?? ""); } catch { id = 0; }
        if (response.status >= 200 && response.status < 300 && id > 0) opened = { url: /^https?:\/\//.test(href) ? href : `${repo.webUrl}/pull-requests/${id}`, number: id };
        else problem = bitbucketError(response);
      }
    } catch (error) { problem = failure(error); }
    finally { await rm(folder, { recursive: true, force: true }); }
    if (!opened) {
      steps.push({ label: "Draft pull request", state: "failed", detail: problem || "The forge didn't confirm the pull request." });
      return { outcome: "failed", reason: `${plan.taskBranch} was pushed as ${short(pushed)}, but the draft pull request wasn't opened: ${problem || "the forge didn't confirm it"}. Open it on ${forgeLabels[repo.forge]}, or try again.`, committed, pushed, steps };
    }
    steps.push({ label: "Draft pull request", state: "done", detail: `Opened draft pull request #${opened.number}: ${opened.url}` });

    // 4. Record it on the task and set the task to In review.
    const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
    try {
      await deps.record(source, {
        forge: repo.forge, url: opened.url, number: opened.number, repository: repo.slug, targetBranch: plan.targetBranch, taskBranch: plan.taskBranch, head: pushed,
        ...(repo.forge === "azure-devops" ? { organizationUrl: repo.organizationUrl } : {}), worktreeDirectory: plan.worktreeDirectory,
        createdAt: (deps.now?.() ?? new Date()).toISOString(),
      }, `- ${day}: In review. Opened draft pull request #${opened.number} (${opened.url}) from ${plan.taskBranch} into ${plan.targetBranch} at ${short(pushed)} from Mission Control${committed ? `, after committing its uncommitted work as ${short(committed)}` : ""}.`);
      steps.push({ label: "Record on the task", state: "done", detail: "Recorded the pull request in task.md, set the task to In review and added a status.md line." });
    } catch (error) { steps.push({ label: "Record on the task", state: "failed", detail: `The pull request is open, but recording it on the task didn't work: ${failure(error)}` }); }
    return { outcome: "opened", forge: repo.forge, url: opened.url, number: opened.number, committed, pushed, steps };
  }

  /** Opens the draft pull request, replying with the result or, for a slow one, that it is still running. A dry run changes nothing and keeps no card. */
  async function start(input: Omit<OpenInput, "dryRun"> & { dryRun?: boolean }, paseo: PaseoApi): Promise<PullRequestReply> {
    if (busy(input.taskId)) return { outcome: "refused", reason: "This task is already being delivered. Attention shows its progress.", checks: [] };
    const full = { ...input, dryRun: input.dryRun ?? false };
    if (full.dryRun) return open(full, paseo, () => {});
    const title = async () => (await deps.sources(input.serverId)).find(item => item.task.taskId === input.taskId)?.task.title ?? input.taskId;
    const started = await results.start("pull-request", input.taskId, title, report => open(full, paseo, report), replyWithin);
    return started.done ? started.result : { outcome: "running", resultId: started.resultId, taskId: input.taskId, step: started.step, startedAt: started.startedAt };
  }

  // ---------- status and Clean up ----------

  const tracked = (source: TaskSource, serverId: string) => {
    const { task } = source;
    return Boolean(task.pullRequest && task.worktree && task.status !== "delivered" && task.status !== "closed" && task.assignments.some(item => item.serverId === serverId));
  };

  /**
   * A recorded pull request's state on its forge, and its head commit now (after any review fixes were pushed),
   * or null when the forge didn't say. Bitbucket gives a short hash.
   */
  async function readState(record: PullRequestRecord): Promise<{ state: PullRequestState; head: string | null }> {
    const hash = (value: unknown) => typeof value === "string" && /^[0-9a-f]{7,40}$/.test(value) ? value : null;
    if (record.forge === "github") {
      const gh = await (deps.gh ?? (() => findGh(env)))();
      if (!gh) throw new Error("gh isn't installed on this host.");
      const result = await run(gh, ["pr", "view", String(record.number), "--repo", record.repository, "--json", "state,isDraft,headRefOid"], { timeoutMs: 30_000 });
      if (result.code !== 0) throw new Error(toolError(result, "gh pr view failed"));
      const parsed = JSON.parse(result.stdout);
      const state = mapState("github", parsed);
      if (!state) throw new Error("gh answered with an unknown state.");
      return { state, head: hash(parsed.headRefOid) };
    }
    if (record.forge === "azure-devops") {
      const az = await (deps.az ?? (() => findAz(env)))();
      if (!az) throw new Error("az isn't installed on this host.");
      const [organization] = record.repository.split("/");
      const detected = detectForge(record.url.replace(/\/pullrequest\/\d+$/, ""));
      const organizationUrl = record.organizationUrl ?? (detected?.forge === "azure-devops" ? detected.organizationUrl : `https://dev.azure.com/${organization}`);
      const result = await run(az, ["repos", "pr", "show", "--id", String(record.number), "--organization", organizationUrl, "--detect", "false", "--output", "json"], { timeoutMs: 30_000 });
      if (result.code !== 0) throw new Error(toolError(result, "az repos pr show failed"));
      const parsed = JSON.parse(result.stdout);
      const state = mapState("azure-devops", parsed);
      if (!state) throw new Error("az answered with an unknown state.");
      return { state, head: hash(parsed.lastMergeSourceCommit?.commitId) };
    }
    const auth = await (deps.bitbucketAuth ?? (() => bitbucketAuth(env)))();
    if (!auth) throw new Error("No Bitbucket credentials on this host.");
    const [workspace, name] = record.repository.split("/");
    const response = await http({ method: "GET", url: `${api}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(name)}/pullrequests/${record.number}`, headers: { Authorization: auth.header, Accept: "application/json" } });
    if (response.status !== 200) throw new Error(bitbucketError(response));
    const parsed = JSON.parse(response.text);
    const state = mapState("bitbucket", parsed);
    if (!state) throw new Error("Bitbucket answered with an unknown state.");
    return { state, head: hash(parsed.source?.commit?.hash) };
  }

  async function refresh(taskId: string, record: PullRequestRecord) {
    const checkedAt = (deps.now?.() ?? new Date()).toISOString();
    try { states.set(taskId, { ...await readState(record), checkedAt, error: null }); }
    catch (error) { states.set(taskId, { state: null, head: null, checkedAt, error: failure(error) }); }
    return states.get(taskId)!;
  }

  /** This host's tasks with a recorded pull request that aren't delivered; with `read`, each state is asked for now. */
  async function list(input: { serverId: string; read?: boolean; taskId?: string }): Promise<{ pullRequests: TrackedPullRequest[] }> {
    const sources = (await deps.sources(input.serverId)).filter(source => tracked(source, input.serverId) && (!input.taskId || source.task.taskId === input.taskId));
    if (input.read) await Promise.all(sources.map(source => refresh(source.task.taskId, source.task.pullRequest!)));
    return {
      pullRequests: sources.map(({ task }) => {
        const record = task.pullRequest!;
        const known = states.get(task.taskId);
        return {
          taskId: task.taskId, title: task.title, workspaceId: task.worktree!.workspaceId, forge: record.forge, url: record.url, number: record.number,
          targetBranch: record.targetBranch, taskBranch: record.taskBranch, createdAt: record.createdAt,
          state: known?.state ?? null, checkedAt: known?.checkedAt ?? null, error: known?.error ?? null,
        };
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }

  // contained: why the local branch holds nothing the pull request didn't, for the steps' wording. checked: the commit the
  // branch was at when that was checked ("" when it was already gone); only that commit is ever deleted.
  type CleanupTarget = { source: TaskSource; record: PullRequestRecord; worktree: NonNullable<TaskRecord["worktree"]>; root: string; contained: string; checked: string };

  async function cleanupTarget(serverId: string, taskId: string, paseo: PaseoApi): Promise<CleanupTarget | { refused: string }> {
    const source = (await deps.sources(serverId)).find(item => item.task.taskId === taskId);
    if (!source || !tracked(source, serverId)) return { refused: "This task has no open pull request on this host to clean up after." };
    const record = source.task.pullRequest!;
    // Asked again now: Clean up runs only after the forge says the pull request merged.
    const read = await refresh(taskId, record);
    if (read.error) return { refused: `Couldn't read the pull request's state: ${read.error}` };
    if (read.state === "closed") return { refused: "The pull request was closed without merging, so there is nothing to clean up. The worktree and branch stay." };
    if (read.state !== "merged") return { refused: `The pull request is ${read.state}, not merged. Clean up is offered once it merges.` };
    const root = await realpath(await deps.projectRoot(source.task.projectId, paseo));
    const checked = await unmergedWork(root, source.task, record, read.head);
    if ("refused" in checked) return checked;
    return { source, record, worktree: source.task.worktree!, root, contained: checked.contained, checked: checked.at };
  }

  /** Every commit of a merged pull request, from its forge: what the pull request contained, even after a squash merge deleted its branch. */
  async function pullRequestCommits(record: PullRequestRecord): Promise<Set<string>> {
    const full = (values: unknown[]) => new Set(values.filter((value): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value)));
    if (record.forge === "github") {
      const gh = await (deps.gh ?? (() => findGh(env)))();
      if (!gh) throw new Error("gh isn't installed on this host.");
      const result = await run(gh, ["pr", "view", String(record.number), "--repo", record.repository, "--json", "commits"], { timeoutMs: 60_000 });
      if (result.code !== 0) throw new Error(toolError(result, "gh pr view failed"));
      return full((JSON.parse(result.stdout).commits ?? []).map((commit: { oid?: unknown }) => commit.oid));
    }
    if (record.forge === "azure-devops") {
      const az = await (deps.az ?? (() => findAz(env)))();
      if (!az) throw new Error("az isn't installed on this host.");
      const [, project, repo] = record.repository.split("/");
      const detected = detectForge(record.url.replace(/\/pullrequest\/\d+$/, ""));
      const organizationUrl = record.organizationUrl ?? (detected?.forge === "azure-devops" ? detected.organizationUrl : null);
      if (!organizationUrl || !project || !repo) throw new Error("The pull request's Azure DevOps organization, project or repository is unknown.");
      const result = await run(az, ["devops", "invoke", "--area", "git", "--resource", "pullRequestCommits", "--route-parameters", `project=${project}`, `repositoryId=${repo}`, `pullRequestId=${record.number}`,
        "--organization", organizationUrl, "--http-method", "GET", "--output", "json"], { timeoutMs: 60_000 });
      if (result.code !== 0) throw new Error(toolError(result, "az devops invoke failed"));
      return full((JSON.parse(result.stdout).value ?? []).map((commit: { commitId?: unknown }) => commit.commitId));
    }
    const auth = await (deps.bitbucketAuth ?? (() => bitbucketAuth(env)))();
    if (!auth) throw new Error("No Bitbucket credentials on this host.");
    const [workspace, name] = record.repository.split("/");
    const hashes: unknown[] = [];
    let url: string | null = `${api}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(name)}/pullrequests/${record.number}/commits?pagelen=100`;
    for (let page = 0; url && page < 20; page++) {
      const response = await http({ method: "GET", url, headers: { Authorization: auth.header, Accept: "application/json" } });
      if (response.status !== 200) throw new Error(bitbucketError(response));
      const parsed = JSON.parse(response.text);
      hashes.push(...(parsed.values ?? []).map((commit: { hash?: unknown }) => commit.hash));
      // Only Bitbucket's own next page, so the Authorization header never goes elsewhere.
      url = typeof parsed.next === "string" && parsed.next.startsWith(`${api}/`) ? parsed.next : null;
    }
    return full(hashes);
  }

  /**
   * Whether cleaning up would lose work the merged pull request didn't contain. The local task branch must have no
   * commit the pull request didn't contain: checked against its final head when that commit is here (review fixes
   * pushed to it are fine), else against the forge's list of the pull request's commits (a head that exists only on
   * the forge, such as after Update branch, and a squash merge that deleted the branch). A branch that is already
   * gone has nothing left to lose. The task's worktree must have no uncommitted changes (untracked files included).
   */
  async function unmergedWork(root: string, task: TaskRecord, record: PullRequestRecord, forgeHead: string | null): Promise<{ contained: string; at: string } | { refused: string }> {
    const refuse = (why: string) => ({ refused: `${why} Nothing was archived or marked delivered.` });
    const at = (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${record.taskBranch}`])).stdout.trim();
    let contained = `${record.taskBranch} is already gone`;
    if (at) {
      const head = forgeHead ? (await git(root, ["rev-parse", "--verify", "--quiet", `${forgeHead}^{commit}`])).stdout.trim() : "";
      if (head) {
        if (at !== head && (await git(root, ["merge-base", "--is-ancestor", at, head])).code !== 0) {
          const extra = Number((await git(root, ["rev-list", "--count", `${head}..${at}`])).stdout.trim()) || 0;
          return refuse(`${record.taskBranch} (at ${short(at)}) has ${plural(extra, "commit")} that the merged pull request's final commit ${short(head)} doesn't, so cleaning up would lose that work. Deliver or remove those commits first.`);
        }
        contained = `the pull request's final commit ${short(head)} contains it`;
      } else {
        // The final head exists only on the forge: compare the branch's own commits with the pull request's.
        const bases = [task.worktree?.baseCommit, `refs/remotes/origin/${record.targetBranch}`];
        const known: string[] = [];
        for (const base of bases) if (base && (await git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`])).stdout.trim()) known.push(base);
        const listed = await git(root, ["rev-list", at, ...(known.length ? ["--not", ...known] : [])]);
        // A failed listing must not read as "no commits of its own".
        if (listed.code !== 0) return refuse(`Couldn't list ${record.taskBranch}'s own commits (${scrub(listed.stderr || "git rev-list failed")}), so Mission Control can't tell whether it holds work the pull request didn't.`);
        const own = listed.stdout.split(/\r?\n/).filter(Boolean);
        let commits: Set<string>;
        try { commits = await pullRequestCommits(record); }
        catch (error) { return refuse(`The pull request's final commit isn't in this repository, and its list of commits couldn't be read from ${forgeLabels[record.forge]} (${failure(error)}), so Mission Control can't tell whether ${record.taskBranch} holds work the pull request didn't.`); }
        const missing = own.filter(commit => !commits.has(commit));
        if (missing.length) return refuse(`${record.taskBranch} (at ${short(at)}) has ${plural(missing.length, "commit")} the merged pull request didn't contain (${missing.slice(0, 5).map(short).join(", ")}), so cleaning up would lose that work. Deliver or remove those commits first.`);
        contained = `all ${plural(own.length, "commit")} of its own are in the merged pull request`;
      }
    }
    // Uncommitted work: in the worktree that has the branch, else in the worktree recorded when the pull request was opened.
    const holder = at ? parseWorktreeList((await git(root, ["worktree", "list", "--porcelain"])).stdout).find(item => item.branch === `refs/heads/${record.taskBranch}`)?.path : undefined;
    const recorded = record.worktreeDirectory && (await git(record.worktreeDirectory, ["rev-parse", "--is-inside-work-tree"]).catch(() => null))?.stdout.trim() === "true" ? record.worktreeDirectory : undefined;
    const directory = holder ?? recorded;
    if (directory) {
      const status = await git(directory, ["status", "--porcelain", "-z", "--untracked-files=normal"]);
      if (status.code !== 0) return refuse(`Couldn't read the worktree ${directory} (${scrub(status.stderr || "git status failed")}), so it may hold uncommitted work.`);
      const changes = status.stdout.split("\0").filter(entry => entry.length > 3).length;
      if (changes) return refuse(`The worktree ${directory} has ${plural(changes, "uncommitted change")} (untracked files included) that the merged pull request doesn't hold. Commit, move or discard them first.`);
    }
    return { contained, at };
  }

  /**
   * The local task branch now. It is deletable only while it still points at `checked`, the commit unmergedWork found
   * the merged pull request contained; a commit added since then was never checked, so the branch is kept.
   */
  async function branchState(root: string, record: PullRequestRecord, contained: string, checked: string) {
    const at = (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${record.taskBranch}`])).stdout.trim();
    if (!at) return { deletable: false, exists: false, at, note: `${record.taskBranch} is already gone.` };
    if (at !== checked) return { deletable: false, exists: true, at, note: `${record.taskBranch} moved to ${short(at)} after it was checked${checked ? ` at ${short(checked)}` : ""}, so it was kept; nothing on it was deleted.` };
    return { deletable: true, exists: true, at, note: `${record.taskBranch} (at ${short(at)}) is deleted: ${contained}.` };
  }

  async function cleanupPlan(input: { serverId: string; taskId: string }, paseo: PaseoApi) {
    const target = await cleanupTarget(input.serverId, input.taskId, paseo);
    if ("refused" in target) return { plan: null, reason: target.refused };
    const branch = await branchState(target.root, target.record, target.contained, target.checked);
    return { plan: { taskTitle: target.source.task.title, url: target.record.url, taskBranch: target.record.taskBranch, worktreeWorkspaceId: target.worktree.workspaceId, branchDeletable: branch.deletable, branchNote: branch.note }, reason: null };
  }

  async function cleanupWork(input: { serverId: string; taskId: string }, paseo: PaseoApi, report: (step: string) => void): Promise<CleanupResult> {
    running.add(input.taskId);
    try {
      report("Reading the pull request's state");
      const first = await cleanupTarget(input.serverId, input.taskId, paseo);
      if ("refused" in first) return { outcome: "refused", reason: first.refused };
      return await withRepository(first.root, async (): Promise<CleanupResult> => {
        // Checked again under the repository lock, just before anything changes.
        const target = await cleanupTarget(input.serverId, input.taskId, paseo);
        if ("refused" in target) return { outcome: "refused", reason: target.refused };
        const { source, record, worktree, root, contained, checked } = target;
        const steps: MergeStep[] = [];
        const step = async (label: string, work: () => Promise<string | { skipped: string }>) => {
          try {
            const outcome = await work();
            steps.push(typeof outcome === "string" ? { label, state: "done", detail: outcome } : { label, state: "skipped", detail: outcome.skipped });
          } catch (error) { steps.push({ label, state: "failed", detail: failure(error) }); }
        };
        report("Cleaning up");
        await step("Clear Review marks", async () => { await deps.clearReviewMarks(worktree.workspaceId); return "Cleared the worktree workspace's Review marks."; });
        await step("Archive worktree workspace", async () => {
          const archived = await paseo.workspaces.ref(worktree.workspaceId).archive();
          if (archived.error || !archived.archivedAt) throw new Error(archived.error || "Paseo did not confirm that the workspace was archived.");
          return "Archived the worktree workspace.";
        });
        await step("Delete local branch", async () => {
          const branch = await branchState(root, record, contained, checked);
          if (!branch.deletable) return branch.exists ? { skipped: branch.note } : branch.note;
          const holder = parseWorktreeList((await git(root, ["worktree", "list", "--porcelain"])).stdout).find(item => item.branch === `refs/heads/${record.taskBranch}`);
          if (holder) return { skipped: `${record.taskBranch} is still checked out in ${holder.path}, so it was kept.` };
          // Deleted only if it still points at the checked commit: Git compares and deletes in one step, so a commit
          // added in the meantime makes it refuse. (Not branch -D, which deletes whatever the branch holds.)
          const deleted = await git(root, ["update-ref", "-d", `refs/heads/${record.taskBranch}`, checked]);
          if (deleted.code !== 0) {
            const now = (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${record.taskBranch}`])).stdout.trim();
            if (now && now !== checked) return { skipped: `${record.taskBranch} moved to ${short(now)} while cleaning up, so it was kept; nothing on it was deleted.` };
            throw new Error(scrub(deleted.stderr || "git update-ref failed"));
          }
          return `Deleted ${record.taskBranch} (it was at ${short(checked)}; ${contained}).`;
        });
        await step("Mark delivered", async () => {
          const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
          await deps.deliver(source, `- ${day}: Delivered. Pull request #${record.number} (${record.url}) merged into ${record.targetBranch}; Mission Control cleaned up.`);
          return "Set the task to delivered and added a status.md line.";
        });
        return { outcome: "cleaned", steps };
      });
    } finally { running.delete(input.taskId); }
  }

  /** Clean up after a merged pull request, only when the user asks: archive the worktree workspace, delete the local branch, mark delivered. */
  async function cleanup(input: { serverId: string; taskId: string }, paseo: PaseoApi): Promise<CleanupReply> {
    if (busy(input.taskId)) return { outcome: "refused", reason: "This task is already being delivered or cleaned up. Attention shows its progress." };
    const title = async () => (await deps.sources(input.serverId)).find(item => item.task.taskId === input.taskId)?.task.title ?? input.taskId;
    const started = await results.start("cleanup", input.taskId, title, report => cleanupWork(input, paseo, report), replyWithin);
    return started.done ? started.result : { outcome: "running", resultId: started.resultId, taskId: input.taskId, step: started.step, startedAt: started.startedAt };
  }

  return { check, start, list, cleanupPlan, cleanup };
}

/**
 * Each Git project on this host with origin's URL (user name and password removed), or why it couldn't be read.
 * Settings → Delivery shows each one's forge, and Setup shows only the forge tools the projects use.
 */
export async function projectRemotes(paseo: Pick<PaseoApi, "projects">): Promise<ProjectRemote[]> {
  const projects = (await paseo.projects.list()).projects.filter(project => project.projectKind === "git");
  return Promise.all(projects.map(async project => {
    const name = project.projectCustomName || project.projectDisplayName;
    try {
      const root = await realpath(project.projectRootPath);
      const origin = await git(root, ["remote", "get-url", "origin"], { timeout: 15_000 });
      return { projectId: project.projectId, name, remote: origin.code === 0 && origin.stdout.trim() ? redactRemoteUrl(origin.stdout.trim()) : null, error: null };
    } catch (error) { return { projectId: project.projectId, name, remote: null, error: failure(error) }; }
  }));
}
