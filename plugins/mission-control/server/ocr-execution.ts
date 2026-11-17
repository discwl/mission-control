import { access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runProcess } from "./process-tree";
import type { PipelineCandidate } from "./pipeline-records.mjs";

const fileSchema = z.object({ path: z.string().min(1), status: z.string().min(1) }).passthrough();
const previewSchema = z.object({ schema_version: z.literal("1"), reviewable_files: z.array(fileSchema), excluded_files: z.array(fileSchema), mode: z.string() }).passthrough();
const rulesSchema = z.object({ schema_version: z.literal("1"), groups: z.array(z.object({ files: z.array(z.string()), rule: z.string().min(1) }).passthrough()) }).passthrough();
export type OcrScope = { base: string | null; rootCommit: string | null; source: "task" | "workspace" | "unborn"; from: string | null; since: string | null };
export async function resolveOcrScope(cwd: string, candidate: PipelineCandidate, taskBase: string | null, saved: { from: string | null; since: string | null; branchBase: string | null }): Promise<OcrScope> {
  if (!candidate.head) return { base: null, rootCommit: null, source: "unborn", from: null, since: null };
  const selected = taskBase ?? saved.since ?? saved.from ?? saved.branchBase;
  if (!selected) throw new Error("Choose the task's starting commit in Review → Change what to review before starting a managed review. Uncommitted changes alone may omit completed work.");
  if (!/^[a-f0-9]{7,64}$/i.test(selected)) throw new Error("The saved review base must be a commit ID. Choose it again in Review.");
  async function git(args: string[]) {
    const result = await runProcess("git", ["-C", cwd, ...args], { cwd, timeoutMs: 15_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
    if (result.code) throw new Error("The saved review base is unavailable or is not an ancestor of the current code. Choose it again in Review.");
    return result.stdout.trim();
  }
  const commit = await git(["rev-parse", "--verify", `${selected}^{commit}`]);
  await git(["merge-base", "--is-ancestor", commit, candidate.head]);
  const inclusive = !taskBase && !saved.since && Boolean(saved.from);
  const parents = inclusive ? (await git(["rev-list", "--parents", "-n", "1", commit])).split(/\s+/).slice(1) : [];
  return { base: inclusive ? parents[0] ?? commit : commit, rootCommit: inclusive && !parents.length ? commit : null, source: taskBase ? "task" : "workspace", from: inclusive ? selected : null, since: inclusive ? null : selected };
}

async function ocrCommand() {
  if (process.platform !== "win32") return { file: "ocr", prefix: [] as string[] };
  // npm's .cmd shim requires a shell. Invoke its installed JS entry with Node instead, keeping every argument separate.
  const entry = join(process.env.APPDATA || "", "npm", "node_modules", "@alibaba-group", "open-code-review", "bin", "ocr.js");
  try { await access(entry); return { file: process.execPath, prefix: [entry] }; }
  catch { throw Object.assign(new Error("Install open-code-review on this host with npm before starting a managed review."), { code: "ENOENT" }); }
}

// OCR updates itself in the background (npm install -g) when it runs, so a run can catch its package half replaced.
const packageFiles = /open-code-review|opencodereview|@alibaba-group[\\/]ocr-/i;
const fileErrors = /\b(ENOENT|EBUSY|EPERM|EACCES)\b/;

/**
 * Whether an OCR failure looks like its package being replaced by that self-update: the launcher or native binary is
 * missing, a module can't be loaded, or a file error names the package's files. Not a review or repository failure.
 */
export function looksLikeOcrUpdate(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && (fileErrors.test(code) || code === "MODULE_NOT_FOUND")) return true;
  const text = error instanceof Error ? error.message : String(error);
  if (/OpenCodeReview binary not found|Cannot find module|MODULE_NOT_FOUND/.test(text)) return true;
  if (/Failed to start /.test(text) && fileErrors.test(text)) return true;
  return text.split(/\r?\n/).some(line => fileErrors.test(line) && packageFiles.test(line));
}

const UPDATE_RETRY_MS = 5_000;
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

export async function executeOcr(cwd: string, scope: OcrScope, candidate: PipelineCandidate, assignmentId: string, options: { retryAfterMs?: number; wait?: (ms: number) => Promise<void> } = {}) {
  const { retryAfterMs = UPDATE_RETRY_MS, wait = pause } = options;
  // One retry per review: enough to ride out one self-update, not enough to hide a broken install.
  let retried = false;
  async function attempt(args: string[]) {
    const command = await ocrCommand();
    const result = await runProcess(command.file, [...command.prefix, ...args], { cwd, timeoutMs: 20_000, maxBuffer: 4_000_000 });
    if (result.code) throw new Error(`OCR failed: ${result.stderr.slice(-1500) || result.stdout.slice(-1500)}`);
    return result.stdout;
  }
  async function run(args: string[]) {
    try { return await attempt(args); }
    catch (error) {
      if (retried || !looksLikeOcrUpdate(error)) throw error;
      retried = true;
      await wait(retryAfterMs);
      return attempt(args);
    }
  }
  const version = (await run(["--version"])).trim();
  const previews = [previewSchema.parse(JSON.parse(await run(["delegate", "preview", "--format", "json", "--repo", cwd])))];
  if (scope.rootCommit) previews.push(previewSchema.parse(JSON.parse(await run(["delegate", "preview", "--format", "json", "--repo", cwd, "--commit", scope.rootCommit]))));
  if (scope.base && candidate.head && scope.base !== candidate.head) previews.push(previewSchema.parse(JSON.parse(await run(["delegate", "preview", "--format", "json", "--repo", cwd, "--from", scope.base, "--to", candidate.head]))));
  const unique = (items: z.infer<typeof fileSchema>[]) => [...new Map(items.map(item => [JSON.stringify([item.path, item.status]), item])).values()];
  const files = unique(previews.flatMap(item => item.reviewable_files));
  const excluded = unique(previews.flatMap(item => item.excluded_files));
  const paths = [...new Set(files.map(item => item.path))];
  if (paths.some(path => path.startsWith("-") || /[\r\n\0]/.test(path))) throw new Error("OCR returned a filename that cannot safely be passed to its rule command.");
  const rules: z.infer<typeof rulesSchema>[] = [];
  for (let at = 0; at < paths.length; at += 20) rules.push(rulesSchema.parse(JSON.parse(await run(["delegate", "rule", "--format", "json", "--repo", cwd, ...paths.slice(at, at + 20)]))));
  const covered = new Set(rules.flatMap(item => item.groups.flatMap(group => group.files)));
  if (paths.some(path => !covered.has(path))) throw new Error("OCR did not resolve rules for every reviewable file.");
  return { schemaVersion: 1, assignmentId, candidate, version, scope, createdAt: new Date().toISOString(), files, excluded, previews, rules };
}
