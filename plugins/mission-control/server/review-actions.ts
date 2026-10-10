import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, win32 } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { runGit, workspaceDirectory } from "./review";

export function checkReviewPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  if (!normalized || isAbsolute(normalized) || win32.isAbsolute(normalized) || /[\0\r\n:]/.test(normalized)
    || normalized.split("/").some(part => !part || /[. ]$/.test(part) || part.toLowerCase() === ".git")) throw new Error("That path is not inside this repository.");
  return normalized;
}
export async function reviewRoot(paseo: PaseoApi, localServer: string, input: { serverId: string; workspaceId: string }): Promise<string> {
  const cwd = await workspaceDirectory(paseo, localServer, input);
  return realpath((await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim());
}
// Reject symlink/reparse paths. Deleted files are valid if existing ancestors stay inside root.
export async function checkedReviewPath(root: string, path: string): Promise<string> {
  let current = root;
  for (const part of checkReviewPath(path).split("/")) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Actions on symbolic links are not supported.");
      const inside = relative(root, await realpath(current));
      if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("That path is not inside this repository.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return current;
}
export async function readReviewText(root: string, path: string) {
  const file = await checkedReviewPath(root, path);
  if (!(await lstat(file)).isFile()) throw new Error("That path is not a file.");
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(16);
    await handle.read(header, 0, header.length, 0);
    const mimeType = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" as const
      : header[0] === 255 && header[1] === 216 && header[2] === 255 ? "image/jpeg" as const
      : ["GIF87a", "GIF89a"].includes(header.toString("ascii", 0, 6)) ? "image/gif" as const
      : header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP" ? "image/webp" as const : null;
    const limit = mimeType ? 2 * 1024 * 1024 : 512 * 1024, buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, Math.min(bytesRead, limit));
    if (mimeType) {
      if (bytesRead > limit) throw new Error("This image exceeds the 2 MB preview limit. Reveal it in Explorer instead.");
      return { text: "", truncated: false, image: { mimeType, base64: bytes.toString("base64") } };
    }
    if (bytes.includes(0)) throw new Error("This binary file format cannot be previewed. Reveal it in Explorer instead.");
    return { text: bytes.toString("utf8"), truncated: bytesRead > limit };
  } finally { await handle.close(); }
}
async function fileStamp(root: string, path: string): Promise<string> {
  const absolute = await checkedReviewPath(root, path);
  let stat;
  try { stat = await lstat(absolute); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return "deleted"; throw error; }
  if (!stat.isFile()) throw new Error("Discard supports files only; directories and submodules are excluded.");
  const hash = createHash("sha256").update(String(stat.mode)), handle = await open(absolute, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024); let count = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      if ((count += bytesRead) > 64 * 1024 * 1024) throw new Error("This file exceeds the 64 MB discard safety limit.");
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally { await handle.close(); }
}
export type DiscardPlan = { paths: string[]; removePaths: string[]; token: string };
export async function planReviewDiscard(root: string, target: string, directory: boolean): Promise<DiscardPlan> {
  target = checkReviewPath(target);
  const head = (await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1])).trim();
  if (!head) throw new Error("Discard is unavailable until the repository has its first commit.");
  const status = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), entries = status.split("\0"), paths = new Set<string>();
  const matches = (path: string) => path === target || (directory && path.startsWith(`${target}/`));
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]; if (!entry) continue;
    const code = entry.slice(0, 2), path = entry.slice(3), oldPath = /[RC]/.test(code) ? entries[++index] : undefined;
    if (!matches(path) && !(oldPath && matches(oldPath))) continue;
    if (code.includes("U") || code === "AA" || code === "DD") throw new Error("Resolve merge conflicts before discarding these files.");
    paths.add(checkReviewPath(path));
    if (oldPath && code.includes("R")) paths.add(checkReviewPath(oldPath));
  }
  const selected = [...paths].sort();
  if (!selected.length) throw new Error("There are no uncommitted changes for this item. Committed changes cannot be discarded here.");
  if (selected.length > 300) throw new Error("Discard at most 300 files at a time. Choose a smaller folder.");
  const headPaths = new Set((await runGit(root, ["--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", "HEAD", "--", ...selected])).split("\0").filter(Boolean));
  const index = await runGit(root, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...selected]);
  const hash = createHash("sha256").update(root).update("\0").update(head).update("\0").update(status).update("\0").update(index);
  for (const path of selected) hash.update("\0").update(path).update("\0").update(await fileStamp(root, path));
  return { paths: selected, removePaths: selected.filter(path => !headPaths.has(path)), token: hash.digest("hex") };
}
const discardLocks = new Set<string>();
export async function applyReviewDiscard(root: string, target: string, directory: boolean, expectedToken: string): Promise<void> {
  if (discardLocks.has(root)) throw new Error("A discard is already in progress for this repository.");
  discardLocks.add(root);
  try {
    const plan = await planReviewDiscard(root, target, directory);
    if (plan.token !== expectedToken) throw new Error("Files or staged changes changed after confirmation. Reopen Discard changes to review them again.");
    const restore = plan.paths.filter(path => !plan.removePaths.includes(path));
    if (restore.length) await runGit(root, ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", ...restore]);
    if (plan.removePaths.length) {
      await runGit(root, ["--literal-pathspecs", "rm", "--cached", "-f", "--ignore-unmatch", "--", ...plan.removePaths]);
      for (const path of plan.removePaths) await rm(await checkedReviewPath(root, path), { force: true });
    }
  } finally { discardLocks.delete(root); }
}
export async function revealReviewPath(root: string, path: string, directory: boolean, launch = spawn, platform = process.platform): Promise<void> {
  if (platform !== "win32") throw new Error("Reveal in Windows Explorer is available on Windows hosts only.");
  const absolute = await checkedReviewPath(root, path);
  const stat = await lstat(absolute).catch(error => { if (error.code === "ENOENT" && !directory) return null; throw error; });
  const folder = directory ? absolute : stat ? null : dirname(absolute);
  if (directory && !stat?.isDirectory()) throw new Error("That folder is not available.");
  await new Promise<void>((resolve, reject) => {
    const child = launch("explorer.exe", folder ? [folder] : ["/select,", absolute], { windowsHide: false, detached: true, stdio: "ignore" });
    child.once("error", error => reject(new Error(`Could not open Windows Explorer: ${error.message}`)));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
