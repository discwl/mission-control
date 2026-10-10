import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const severitySchema = z.enum(["high", "medium", "low", "info"]);
export type Severity = z.infer<typeof severitySchema>;

export const diffLineSchema = z.object({
  kind: z.enum(["add", "del", "context", "meta"]),
  old: z.number().int().nullable(),
  new: z.number().int().nullable(),
  text: z.string(),
});
export type DiffLine = z.infer<typeof diffLineSchema>;

export const reviewHunkSchema = z.object({
  // Hash of path and hunk body only, so the ID survives unrelated edits and line shifts.
  contentId: z.string(),
  header: z.string(),
  context: z.string().nullable(),
  oldStart: z.number().int(),
  newStart: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
  severity: severitySchema,
  reasons: z.array(z.string()),
  lines: z.array(diffLineSchema),
});
export type ReviewHunk = z.infer<typeof reviewHunkSchema>;

export const reviewFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  change: z.enum(["added", "modified", "deleted", "renamed", "binary"]),
  additions: z.number().int(),
  deletions: z.number().int(),
  severity: severitySchema,
  reasons: z.array(z.string()),
  hunks: z.array(reviewHunkSchema),
  // What a "reviewed" mark attaches to: each hunk's contentId, or one file-level ID when there are no hunks.
  reviewIds: z.array(z.string()),
  // Lines were cut to keep the snapshot small; the file is still listed.
  truncated: z.boolean(),
});
export type ReviewFile = z.infer<typeof reviewFileSchema>;

export const reviewSnapshotSchema = z.object({
  fingerprint: z.string(),
  generatedAt: z.string(),
  repoRoot: z.string(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  // What the working tree is compared against: the last commit, nothing yet, the parent of a chosen
  // commit ("commit"), or a branch point such as where a task worktree started ("since").
  base: z.enum(["head", "empty", "commit", "since"]),
  // Set when reviewing from a commit onward: that commit and how many commits are included.
  fromCommit: z.object({ sha: z.string(), short: z.string(), subject: z.string(), commits: z.number().int() }).nullable(),
  // Set when reviewing everything after a branch point: that commit and how many commits followed it.
  sinceCommit: z.object({ sha: z.string(), short: z.string(), subject: z.string(), commits: z.number().int() }).nullable(),
  baseWarning: z.string().nullable(),
  files: z.array(reviewFileSchema),
  omittedFiles: z.number().int().nonnegative(),
});
export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;

export const getReviewSnapshot = defineRpc({
  name: "review.snapshot",
  input: z.object({ serverId: z.string().min(1), workspaceId: z.string().min(1) }),
  output: reviewSnapshotSchema,
});

export const reviewCommitSchema = z.object({ sha: z.string(), short: z.string(), subject: z.string(), author: z.string(), date: z.string() });
export type ReviewCommit = z.infer<typeof reviewCommitSchema>;

const workspaceRef = z.object({ serverId: z.string().min(1), workspaceId: z.string().min(1) });
// Review state per workspace: reviewed marks, and what to compare with. `from` includes a chosen
// commit; `since` excludes a branch point; both null means uncommitted changes only. `branchBase`
// remembers where a task worktree branched so the choice can be offered again.
const marksSchema = z.object({
  marks: z.record(z.string(), z.string()),
  from: z.string().nullable(),
  since: z.string().nullable(),
  branchBase: z.string().nullable(),
});

export const isMarkdownPath = (path: string) => /\.(md|mdx|markdown)$/i.test(path);
// The current working-tree text of one Markdown file in the review, for its preview.
export const readReviewFile = defineRpc({
  name: "review.file",
  input: workspaceRef.extend({ path: z.string().min(1).max(1000) }),
  output: z.object({ text: z.string(), truncated: z.boolean() }),
});
const reviewPathRef = workspaceRef.extend({ path: z.string().min(1).max(1000), directory: z.boolean() });
export const readReviewWorkingFile = defineRpc({ name: "review.working-file", input: workspaceRef.extend({ path: z.string().min(1).max(1000) }), output: z.object({ text: z.string(), truncated: z.boolean(), image: z.object({ mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]), base64: z.string().max(2_800_000) }).optional() }) });
export const revealReviewItem = defineRpc({ name: "review.reveal", input: reviewPathRef, output: z.object({ ok: z.literal(true) }) });
export const resolveReviewItemPath = defineRpc({ name: "review.item-path", input: reviewPathRef, output: z.object({ path: z.string() }) });
export const prepareReviewDiscard = defineRpc({ name: "review.discard.prepare", input: reviewPathRef, output: z.object({ paths: z.array(z.string()), removePaths: z.array(z.string()), token: z.string().regex(/^[a-f0-9]{64}$/) }) });
export const discardReviewChanges = defineRpc({ name: "review.discard.apply", input: reviewPathRef.extend({ token: z.string().regex(/^[a-f0-9]{64}$/) }), output: z.object({ ok: z.literal(true) }) });

export const getReviewCommits = defineRpc({ name: "review.commits", input: workspaceRef, output: z.object({ commits: z.array(reviewCommitSchema) }) });
export const setReviewFrom = defineRpc({
  name: "review.from.set",
  input: workspaceRef.extend({ from: z.string().regex(/^[0-9a-f]{40}$/).nullable() }),
  output: marksSchema,
});
export const setReviewSince = defineRpc({
  name: "review.since.set",
  input: workspaceRef.extend({ since: z.string().regex(/^[0-9a-f]{40}$/).nullable() }),
  output: marksSchema,
});

export const getReviewMarks = defineRpc({ name: "review.marks.get", input: workspaceRef, output: marksSchema });
export const setReviewMarks = defineRpc({
  name: "review.marks.set",
  input: workspaceRef.extend({ ids: z.array(z.string().regex(/^[a-f0-9]{16}$/)).min(1).max(500), reviewed: z.boolean() }),
  output: marksSchema,
});
// For the chat bubble: installation-host workspaces only, so no serverId is needed.
// `pending` lists workspaces whose first scan is still running; the next poll picks it up.
export const getReviewCounts = defineRpc({
  name: "review.counts",
  input: z.object({ workspaceIds: z.array(z.string().min(1)).max(50) }),
  output: z.object({
    counts: z.record(z.string(), z.object({ files: z.number().int(), toReview: z.number().int() }).nullable()),
    pending: z.array(z.string()).optional(),
  }),
});

// A snapshot that outlasts one request keeps running on the host; Review polls until it finishes.
export const reviewScanPendingMessage = "Still reading this workspace's changes. Git is slow on this host, so they appear when the scan finishes.";
export const isReviewScanPending = (error: unknown) => error instanceof Error && error.message.includes(reviewScanPendingMessage);

// Comments anchor to a file, or to one line by side, number, hunk content and line text,
// so they can follow their line when other code moves and show as outdated when it changes.
export const commentAnchorSchema = z.object({
  side: z.enum(["old", "new"]),
  line: z.number().int().positive(),
  contentId: z.string().regex(/^[a-f0-9]{16}$/),
  text: z.string().max(2000),
});
export type CommentAnchor = z.infer<typeof commentAnchorSchema>;
export const reviewCommentSchema = z.object({
  commentId: z.string().regex(/^c_[a-f0-9]{16}$/),
  path: z.string().min(1).max(1000),
  anchor: commentAnchorSchema.nullable(),
  body: z.string().min(1).max(4000),
  // open: saved, not sent · sent: delivered to an agent · resolved: the user checked it.
  status: z.enum(["open", "sent", "resolved"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  sentTo: z.string().nullable(),
  sentAt: z.string().nullable(),
  // A failed or unconfirmed send stays "sending" until the user confirms what happened.
  delivery: z.object({ phase: z.enum(["sending", "sent"]), error: z.string().nullable() }).nullable(),
});
export type ReviewComment = z.infer<typeof reviewCommentSchema>;
const commentsSchema = z.object({ comments: z.array(reviewCommentSchema) });

export const listReviewComments = defineRpc({ name: "review.comments.list", input: workspaceRef, output: commentsSchema });
export const saveReviewComment = defineRpc({
  name: "review.comments.save",
  input: workspaceRef.extend({ commentId: z.string().regex(/^c_[a-f0-9]{16}$/).optional(), path: z.string().min(1).max(1000), anchor: commentAnchorSchema.nullable(), body: z.string().trim().min(1).max(4000) }),
  output: commentsSchema,
});
export const updateReviewComment = defineRpc({
  name: "review.comments.update",
  input: workspaceRef.extend({ commentId: z.string().regex(/^c_[a-f0-9]{16}$/), action: z.enum(["delete", "resolve", "reopen", "confirm-sent", "confirm-not-sent"]) }),
  output: commentsSchema,
});
export const sendReviewComments = defineRpc({
  name: "review.comments.send",
  input: workspaceRef.extend({
    agentId: z.string().min(1),
    commentIds: z.array(z.string().regex(/^c_[a-f0-9]{16}$/)).min(1).max(50),
    workspaceName: z.string().max(300),
    scopeLabel: z.string().max(300),
  }),
  output: commentsSchema.extend({ error: z.string().nullable() }),
});

export const reviewCommentsKey = (serverId: string, workspaceId: string) => ["mission-control", "review-comments", serverId, workspaceId] as const;
export const reviewMarksKey = (serverId: string, workspaceId: string) => ["mission-control", "review-marks", serverId, workspaceId] as const;
export const reviewSnapshotKey = (serverId: string, workspaceId: string) => ["mission-control", "review", serverId, workspaceId] as const;
