import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, win32 } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { isMarkdownPath, type ReviewCommit, type ReviewSnapshot } from "../shared/review";
import { parseDiff } from "./review-diff";
import { severityRank } from "./review-rules";

const maxOutput = 8 * 1024 * 1024;
const maxUntracked = 200;
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const shaPattern = /^[0-9a-f]{7,40}$/;
// Fixed flags so user git config (noprefix, color, external diff) cannot change the output.
const diffFlags = ["--no-color", "--no-ext-diff", "--no-textconv", "-M", "--src-prefix=a/", "--dst-prefix=b/"];
// Git's binary test: a NUL byte in the first 8000 bytes.
const binaryProbe = 8000;
const tooLarge = "These changes are larger than the 8 MB review limit.";

async function readStart(file: string, bytes: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

// Git's core.quotePath=true quoting, so a built header parses exactly like one Git printed.
function headerPath(prefix: string, name: string): string {
  const bytes = Buffer.from(prefix + name, "utf8");
  if (!bytes.some(byte => byte < 0x20 || byte === 0x22 || byte === 0x5c || byte >= 0x7f)) return prefix + name;
  const named: Record<number, string> = { 7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r", 0x22: "\"", 0x5c: "\\" };
  let quoted = "";
  for (const byte of bytes) {
    if (named[byte]) quoted += `\\${named[byte]}`;
    else if (byte < 0x20 || byte >= 0x7f) quoted += `\\${byte.toString(8).padStart(3, "0")}`;
    else quoted += String.fromCharCode(byte);
  }
  return `"${quoted}"`;
}

/**
 * What `git diff --no-index /dev/null <name>` prints for an untracked file, built from the file itself.
 * Launching Git once per untracked file is too slow where security software delays every Git start.
 * Hunk bodies match Git's, so content IDs and saved review marks carry over. A file that vanished
 * since Git listed it yields nothing.
 */
export async function untrackedDiff(cwd: string, name: string): Promise<string> {
  const file = join(cwd, name);
  let content: Buffer;
  let mode = "100644";
  let large = false;
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) { mode = "120000"; content = Buffer.from(await readlink(file), "utf8"); }
    else if (!info.isFile()) return "";
    else {
      if (process.platform !== "win32" && info.mode & 0o111) mode = "100755";
      // A big file is only read far enough to tell binary from text.
      large = info.size > maxOutput;
      content = large ? await readStart(file, binaryProbe) : await readFile(file);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  const target = headerPath("b/", name);
  // Like Git's, every line ends in a newline: a CRLF file's last "\r" must not reach the parser.
  const output = (lines: string[]) => `${lines.join("\n")}\n`;
  const header = [`diff --git ${headerPath("a/", name)} ${target}`, `new file mode ${mode}`];
  if (!content.length) return output(header);
  // Git prints one line for a binary file of any size.
  if (content.subarray(0, binaryProbe).includes(0)) return output([...header, `Binary files /dev/null and ${target} differ`]);
  // Too much text to show: list the file without its lines instead of failing the whole review.
  if (large) return output(header);
  const lines = content.toString("utf8").split("\n");
  const endsWithNewline = lines[lines.length - 1] === "";
  if (endsWithNewline) lines.pop();
  return output([
    ...header, "--- /dev/null", `+++ ${target}`, `@@ -0,0 +1${lines.length === 1 ? "" : `,${lines.length}`} @@`,
    ...lines.map(line => `+${line}`), ...(endsWithNewline ? [] : ["\\ No newline at end of file"]),
  ]);
}

function spawnGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const forward = cwd.replaceAll("\\", "/");
    const child = spawn("git", ["-c", `safe.directory=${cwd}`, "-c", `safe.directory=${forward}`, "-c", "core.quotePath=true", "-C", cwd, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= maxOutput) out.push(chunk); else child.kill(); });
    child.stderr.on("data", (chunk: Buffer) => { if (err.length < 64) err.push(chunk); });
    child.on("error", reject);
    child.on("close", code => {
      if (size > maxOutput) return reject(new Error(tooLarge));
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8").trim() });
    });
  });
}

export async function runGit(cwd: string, args: string[], acceptable: number[] = [0]): Promise<string> {
  const result = await spawnGit(cwd, args);
  if (!acceptable.includes(result.code)) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout;
}

export async function listCommits(directory: string, limit = 25): Promise<ReviewCommit[]> {
  const cwd = await realpath(directory);
  const head = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1])).trim();
  if (!head) return [];
  const out = await runGit(cwd, ["log", "-n", String(limit), "--no-color", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI", "HEAD", "--"]);
  return out.split("\n").filter(Boolean).map(line => {
    const [sha, short, subject, author, date] = line.split("\x1f");
    return { sha, short, subject, author, date };
  });
}

/**
 * Changes to review: the working tree (staged, unstaged and untracked) compared with HEAD; or, when
 * `from` names a commit, with that commit's parent so the commits from `from` onward are included;
 * or, when `since` names a branch point, with that commit so everything after it is included.
 * Before the first commit everything is compared with the empty tree.
 */
export async function collectSnapshot(directory: string, from: string | null = null, since: string | null = null): Promise<ReviewSnapshot> {
  const cwd = await realpath(directory);
  // Independent reads start together: where every Git start is slow, sequential launches add up past
  // the daemon's request limit. Without a saved range the diff against HEAD can start now as well.
  const headDiff = from || since ? null : spawnGit(cwd, ["diff", ...diffFlags, "HEAD", "--"]);
  void headDiff?.catch(() => undefined);
  const [repoRootOut, headOut, branchOut, untrackedOut] = await Promise.all([
    runGit(cwd, ["rev-parse", "--show-toplevel"]),
    runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1]),
    runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1]),
    runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const repoRoot = repoRootOut.trim();
  const head = headOut.trim() || null;
  const branch = branchOut.trim() || null;
  let base = head ?? emptyTree;
  let fromCommit: ReviewSnapshot["fromCommit"] = null;
  let sinceCommit: ReviewSnapshot["sinceCommit"] = null;
  let baseWarning: string | null = null;
  // A saved commit only counts while it is still in this branch's history.
  const onBranch = async (sha: string) => {
    const resolved = shaPattern.test(sha) ? (await runGit(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^{commit}`], [0, 1])).trim() : "";
    return resolved && (await spawnGit(cwd, ["merge-base", "--is-ancestor", resolved, "HEAD"])).code === 0 ? resolved : null;
  };
  const describe = async (sha: string) => (await runGit(cwd, ["log", "-1", "--no-color", "--format=%h%x1f%s", sha, "--"])).trim().split("\x1f");
  if (from && head) {
    const resolved = await onBranch(from);
    if (!resolved) baseWarning = `The saved starting commit ${from.slice(0, 7)} is no longer in this branch's history, so only uncommitted changes are shown.`;
    else {
      const parent = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${resolved}^`], [0, 1])).trim();
      base = parent || emptyTree;
      const [short, subject] = await describe(resolved);
      // Commits from `from` through HEAD, inclusive.
      const count = Number((await runGit(cwd, ["rev-list", "--count", parent ? `${parent}..HEAD` : "HEAD"])).trim()) || 0;
      fromCommit = { sha: resolved, short, subject, commits: count };
    }
  } else if (since && head) {
    const resolved = await onBranch(since);
    if (!resolved) baseWarning = `The branch point ${since.slice(0, 7)} is no longer in this branch's history, so only uncommitted changes are shown.`;
    else {
      base = resolved;
      const [short, subject] = await describe(resolved);
      const count = Number((await runGit(cwd, ["rev-list", "--count", `${resolved}..HEAD`])).trim()) || 0;
      sinceCommit = { sha: resolved, short, subject, commits: count };
    }
  }
  let tracked: string;
  const early = headDiff && head ? await headDiff : null;
  if (early) {
    if (early.code !== 0) throw new Error(early.stderr || "git diff failed");
    tracked = early.stdout;
  } else tracked = await runGit(cwd, ["diff", ...diffFlags, base, "--"]);
  const untrackedNames = untrackedOut.split("\0").filter(Boolean);
  const untracked = (await Promise.all(untrackedNames.slice(0, maxUntracked).map(name => untrackedDiff(cwd, name)))).filter(Boolean);
  const raw = [tracked, ...untracked].join("\n");
  const files = parseDiff(raw).sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.path.localeCompare(b.path));
  const fingerprint = createHash("sha256").update(head ?? "unborn").update("\0").update(base).update("\0").update(raw).digest("hex");
  return {
    fingerprint, generatedAt: new Date().toISOString(), repoRoot, branch, head,
    base: fromCommit ? "commit" : sinceCommit ? "since" : head ? "head" : "empty", fromCommit, sinceCommit, baseWarning,
    files, omittedFiles: Math.max(0, untrackedNames.length - maxUntracked),
  };
}

export async function workspaceDirectory(paseo: PaseoApi, localServer: string, input: { serverId: string; workspaceId: string }) {
  if (input.serverId !== localServer) throw new Error("Review reads files on this Mission Control host only. Install Mission Control on that host to review it.");
  const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
  if (!workspace || workspace.archivingAt) throw new Error("This workspace is not available on this host.");
  const directory = workspace.workspaceDirectory || workspace.projectRootPath;
  if (!directory) throw new Error("This workspace has no folder to review.");
  return directory;
}

const maxPreviewBytes = 512 * 1024;

/** Reads one Markdown file from the working tree. Paths are relative to the repository root, as in the diff. */
export async function readMarkdownFile(directory: string, path: string): Promise<{ text: string; truncated: boolean }> {
  if (!isMarkdownPath(path)) throw new Error("Only Markdown files can be previewed.");
  const parts = path.split(/[\\/]/);
  if (path.includes("\0") || isAbsolute(path) || win32.isAbsolute(path) || parts.includes("..") || parts.some(part => part.toLowerCase() === ".git")) {
    throw new Error("That file path is not inside this repository.");
  }
  const cwd = await realpath(directory);
  const repoRoot = await realpath((await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim());
  // realpath follows links, so a link pointing outside the repository is rejected here.
  const file = await realpath(join(repoRoot, path));
  const inside = relative(repoRoot, file);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("That file path is not inside this repository.");
  if (!(await lstat(file)).isFile()) throw new Error("That path is not a file.");
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(maxPreviewBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, Math.min(bytesRead, maxPreviewBytes)).toString("utf8"), truncated: bytesRead > maxPreviewBytes };
  } finally { await handle.close(); }
}

export async function workspaceMarkdown(paseo: PaseoApi, localServer: string, input: { serverId: string; workspaceId: string; path: string }) {
  const directory = await workspaceDirectory(paseo, localServer, input);
  try { return await readMarkdownFile(directory, input.path); } catch (error) { friendly(error); }
}

function friendly(error: unknown): never {
  if (error instanceof Error && /not a git repository/i.test(error.message)) throw new Error("This workspace is not a Git repository, so there are no changes to review.");
  throw error;
}

export async function directorySnapshot(directory: string, from: string | null = null, since: string | null = null) {
  try { return await collectSnapshot(directory, from, since); } catch (error) { friendly(error); }
}

export async function workspaceCommits(paseo: PaseoApi, localServer: string, input: { serverId: string; workspaceId: string }) {
  const directory = await workspaceDirectory(paseo, localServer, input);
  try { return await listCommits(directory); } catch (error) { friendly(error); }
}
