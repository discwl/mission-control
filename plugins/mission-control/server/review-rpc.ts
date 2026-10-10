import { realpath } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  getReviewCommits,
  getReviewCounts,
  getReviewMarks,
  getReviewSnapshot,
  listReviewComments,
  readReviewFile,
  readReviewWorkingFile,
  revealReviewItem,
  prepareReviewDiscard,
  discardReviewChanges,
  saveReviewComment,
  sendReviewComments,
  setReviewFrom,
  setReviewMarks,
  setReviewSince,
  updateReviewComment,
  reviewScanPendingMessage,
  type ReviewSnapshot,
} from "../shared/review";
import { directorySnapshot, workspaceCommits, workspaceDirectory, workspaceMarkdown } from "./review";
import { createReviewCommentStore } from "./review-comments";
import { countToReview, createReviewMarkStore } from "./review-marks";
import { localServerId } from "./tasks";
import { resolveReviewItemPath } from "../shared/review";
import { applyReviewDiscard, checkedReviewPath, planReviewDiscard, readReviewText, revealReviewPath, reviewRoot } from "./review-actions";

// Review polls every 10 seconds; a scan that finished since the last poll answers the next one,
// so a scan slower than one request still reaches the screen.
const snapshotFreshMs = 12_000;
// Chat bubbles reuse a finished scan this long, and show an older one while a refresh runs.
const countsFreshMs = 20_000;
const countsKeepMs = 10 * 60_000;

type Scan = { running: Promise<ReviewSnapshot> | null; last: { snapshot: ReviewSnapshot; at: number } | null };
type ReviewDeps = {
  snapshot: (directory: string, from: string | null, since: string | null) => Promise<ReviewSnapshot>;
  directory: (paseo: PaseoApi, serverId: string, workspaceId: string) => Promise<string>;
  serverId: () => Promise<string>;
  now: () => number;
  // The daemon abandons a plugin request after 30 seconds; answer before that.
  snapshotWaitMs: number;
  countsWaitMs: number;
};

async function within<T>(promise: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ done: false }>(resolve => { timer = setTimeout(() => resolve({ done: false }), Math.max(0, ms)); });
  try { return await Promise.race([promise.then(value => ({ done: true as const, value })), timeout]); } finally { clearTimeout(timer); }
}

export function registerReview(server: PluginServerContext, vaultRoot: string, overrides: Partial<ReviewDeps> = {}) {
  const deps: ReviewDeps = {
    snapshot: directorySnapshot,
    directory: async (paseo, serverId, workspaceId) => realpath(await workspaceDirectory(paseo, await deps.serverId(), { serverId, workspaceId })),
    serverId: localServerId,
    now: Date.now,
    snapshotWaitMs: 24_000,
    countsWaitMs: 20_000,
    ...overrides,
  };
  const marks = createReviewMarkStore(vaultRoot);
  const comments = createReviewCommentStore(vaultRoot);
  // One scan per folder and review range: workspaces sharing a checkout share it, and a scan that
  // outlasts its request keeps running so the next request picks it up instead of starting another.
  const scans = new Map<string, Scan>();
  const localOnly = async (serverId: string) => {
    if (serverId !== await localServerId()) throw new Error("Review data is stored on this Mission Control host only.");
  };
  async function scanFor(paseo: PaseoApi, serverId: string, workspaceId: string) {
    const stored = await marks.read(workspaceId);
    const directory = await deps.directory(paseo, serverId, workspaceId);
    const now = deps.now();
    for (const [key, entry] of scans) if (!entry.running && (!entry.last || now - entry.last.at > countsKeepMs)) scans.delete(key);
    const key = JSON.stringify([directory, stored.from, stored.since]);
    let entry = scans.get(key);
    if (!entry) { entry = { running: null, last: null }; scans.set(key, entry); }
    const scan = entry;
    const start = () => {
      if (scan.running) return scan.running;
      const running = deps.snapshot(directory, stored.from, stored.since);
      scan.running = running;
      running.then(snapshot => { scan.last = { snapshot, at: deps.now() }; }, () => undefined)
        .finally(() => { if (scan.running === running) scan.running = null; });
      return running;
    };
    return { scan, start, marks: stored.marks };
  }

  server.handle(getReviewSnapshot, async ({ serverId, workspaceId }, { paseo }) => {
    const { scan, start } = await scanFor(paseo, serverId, workspaceId);
    if (scan.last && deps.now() - scan.last.at <= snapshotFreshMs) return scan.last.snapshot;
    const result = await within(start(), deps.snapshotWaitMs);
    if (!result.done) throw new Error(reviewScanPendingMessage);
    return result.value;
  });
  server.handle(readReviewFile, async (input, { paseo }) => workspaceMarkdown(paseo, await localServerId(), input));
  server.handle(readReviewWorkingFile, async (input, { paseo }) => readReviewText(await reviewRoot(paseo, await localServerId(), input), input.path));
  server.handle(resolveReviewItemPath, async (input, { paseo }) => ({
    path: await checkedReviewPath(await reviewRoot(paseo, await localServerId(), input), input.path),
  }));
  server.handle(revealReviewItem, async (input, { paseo }) => {
    await revealReviewPath(await reviewRoot(paseo, await localServerId(), input), input.path, input.directory);
    return { ok: true as const };
  });
  server.handle(prepareReviewDiscard, async (input, { paseo }) => planReviewDiscard(await reviewRoot(paseo, await localServerId(), input), input.path, input.directory));
  server.handle(discardReviewChanges, async (input, { paseo }) => {
    await applyReviewDiscard(await reviewRoot(paseo, await localServerId(), input), input.path, input.directory, input.token);
    // Any shared scan may include the discarded file; the next request rescans.
    scans.clear();
    return { ok: true as const };
  });
  server.handle(getReviewCommits, async (input, { paseo }) => ({ commits: await workspaceCommits(paseo, await localServerId(), input) }));
  server.handle(getReviewMarks, async ({ serverId, workspaceId }) => { await localOnly(serverId); return marks.read(workspaceId); });
  server.handle(setReviewMarks, async ({ serverId, workspaceId, ids, reviewed }) => { await localOnly(serverId); return marks.set(workspaceId, ids, reviewed); });
  // A new range changes the scan key, so these need no cache invalidation.
  server.handle(setReviewFrom, async ({ serverId, workspaceId, from }) => { await localOnly(serverId); return marks.setFrom(workspaceId, from); });
  server.handle(setReviewSince, async ({ serverId, workspaceId, since }) => { await localOnly(serverId); return marks.setSince(workspaceId, since); });
  server.handle(getReviewCounts, async ({ workspaceIds }, { paseo }) => {
    const serverId = await deps.serverId();
    const deadline = deps.now() + deps.countsWaitMs;
    const counts: Record<string, { files: number; toReview: number } | null> = {};
    const pending: string[] = [];
    await Promise.all([...new Set(workspaceIds)].map(async workspaceId => {
      try {
        const { scan, start, marks: reviewed } = await scanFor(paseo, serverId, workspaceId);
        const age = scan.last ? deps.now() - scan.last.at : Infinity;
        let snapshot = age <= countsFreshMs ? scan.last!.snapshot : null;
        if (!snapshot) {
          const running = start();
          // An older count beats none while a refresh runs; a first scan gets until the deadline.
          if (scan.last && age <= countsKeepMs) snapshot = scan.last.snapshot;
          else {
            const result = await within(running, deadline - deps.now());
            if (result.done) snapshot = result.value;
          }
        }
        if (snapshot) counts[workspaceId] = { files: snapshot.files.length, toReview: countToReview(snapshot.files, reviewed) };
        else pending.push(workspaceId);
      } catch { counts[workspaceId] = null; }
    }));
    return { counts, pending };
  });

  server.handle(listReviewComments, async ({ serverId, workspaceId }) => { await localOnly(serverId); return { comments: await comments.list(workspaceId) }; });
  server.handle(saveReviewComment, async ({ serverId, workspaceId, ...input }) => { await localOnly(serverId); return { comments: await comments.save(workspaceId, input) }; });
  server.handle(updateReviewComment, async ({ serverId, workspaceId, commentId, action }) => { await localOnly(serverId); return { comments: await comments.update(workspaceId, commentId, action) }; });
  server.handle(sendReviewComments, async ({ serverId, workspaceId, ...input }, { paseo }) => { await localOnly(serverId); return comments.send(workspaceId, input, paseo); });
  // Shared with the task launcher so a new worktree's branch point goes through the same writer.
  return { marks };
}
