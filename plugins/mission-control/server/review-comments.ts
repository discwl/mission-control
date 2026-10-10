import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { reviewCommentSchema, type CommentAnchor, type ReviewComment } from "../shared/review";
import { checkWorkspaceId, createQueue, reviewFolder, writeAtomic } from "./review-marks";

const maxComments = 1000;
const fileSchema = z.object({ schemaVersion: z.literal(1), workspaceId: z.string(), comments: z.array(reviewCommentSchema) });
type Action = "delete" | "resolve" | "reopen" | "confirm-sent" | "confirm-not-sent";

/** The chat message that carries review comments to an agent. */
export function commentMessage(comments: ReviewComment[], workspaceName: string, scopeLabel: string): string {
  const lines = [
    `Review comments on workspace "${workspaceName}" (${scopeLabel}), from the user's Mission Control review.`,
    "Address each comment, then reply with each comment ID and what you changed, or why you changed nothing.",
    "The user checks and resolves comments; do not treat any comment as resolved yourself.",
    "",
  ];
  for (const comment of comments) {
    const where = comment.anchor
      ? `${comment.path} line ${comment.anchor.line} (${comment.anchor.side === "new" ? "current code" : "removed code"})`
      : `${comment.path} (whole file)`;
    lines.push(`[${comment.commentId}] ${where}`);
    if (comment.anchor?.text.trim()) lines.push(`> ${comment.anchor.text.trimEnd()}`);
    lines.push(`Comment: ${comment.body}`, "");
  }
  return lines.join("\n").trim();
}

// Comments are never deleted once sent: they move to "sent" and then "resolved" by the user.
export function createReviewCommentStore(vaultRoot: string) {
  const enqueue = createQueue();

  async function fileFor(workspaceId: string) {
    checkWorkspaceId(workspaceId);
    return join(await reviewFolder(vaultRoot), `${workspaceId}.comments.json`);
  }

  async function list(workspaceId: string): Promise<ReviewComment[]> {
    let text: string;
    try { text = await readFile(await fileFor(workspaceId), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const parsed = fileSchema.parse(JSON.parse(text));
    if (parsed.workspaceId !== workspaceId) throw new Error("Review comments belong to another workspace.");
    return parsed.comments;
  }

  function mutate<T>(workspaceId: string, change: (comments: ReviewComment[], now: string) => T) {
    return enqueue(workspaceId, async () => {
      let comments = await list(workspaceId);
      const result = change(comments, new Date().toISOString());
      const resolved = comments.filter(comment => comment.status === "resolved");
      if (comments.length > maxComments && resolved.length) {
        const drop = new Set(resolved.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, comments.length - maxComments).map(comment => comment.commentId));
        comments = comments.filter(comment => !drop.has(comment.commentId));
      }
      await writeAtomic(await fileFor(workspaceId), JSON.stringify({ schemaVersion: 1, workspaceId, comments }));
      return { comments, result };
    });
  }

  async function save(workspaceId: string, input: { commentId?: string; path: string; anchor: CommentAnchor | null; body: string }) {
    return (await mutate(workspaceId, (comments, now) => {
      if (input.commentId) {
        const comment = comments.find(item => item.commentId === input.commentId);
        if (!comment) throw new Error("That comment no longer exists.");
        if (comment.status !== "open" || comment.delivery) throw new Error("Only unsent comments can be edited.");
        comment.body = input.body;
        comment.updatedAt = now;
        return;
      }
      comments.push({
        commentId: `c_${randomBytes(8).toString("hex")}`, path: input.path, anchor: input.anchor, body: input.body,
        status: "open", createdAt: now, updatedAt: now, sentTo: null, sentAt: null, delivery: null,
      });
    })).comments;
  }

  async function update(workspaceId: string, commentId: string, action: Action) {
    return (await mutate(workspaceId, (comments, now) => {
      const index = comments.findIndex(item => item.commentId === commentId);
      const comment = comments[index];
      if (!comment) throw new Error("That comment no longer exists.");
      const unconfirmed = comment.delivery?.phase === "sending";
      if (action === "delete") {
        if (comment.status !== "open" || comment.delivery) throw new Error("Sent comments are kept. Resolve it instead.");
        comments.splice(index, 1);
        return;
      }
      if (action === "resolve") {
        if (comment.status === "resolved" || unconfirmed) throw new Error("Confirm whether the agent received it first.");
        comment.status = "resolved";
      } else if (action === "reopen") {
        if (comment.status !== "resolved") throw new Error("Only resolved comments can be reopened.");
        comment.status = "open";
        comment.delivery = null;
      } else if (action === "confirm-sent") {
        if (!unconfirmed) throw new Error("This comment has no unconfirmed delivery.");
        comment.status = "sent";
        comment.sentAt ??= now;
        comment.delivery = { phase: "sent", error: null };
      } else {
        if (!unconfirmed) throw new Error("This comment has no unconfirmed delivery.");
        comment.delivery = null;
        comment.sentTo = null;
      }
      comment.updatedAt = now;
    })).comments;
  }

  async function send(workspaceId: string, input: { agentId: string; commentIds: string[]; workspaceName: string; scopeLabel: string }, paseo: PaseoApi) {
    let agent;
    try { agent = (await paseo.agents.ref(input.agentId).refresh())?.agent ?? null; }
    catch (error) {
      if (!(error instanceof Error && error.message === `Agent not found: ${input.agentId}`)) throw error;
      agent = null;
    }
    if (!agent || agent.archivedAt || agent.status === "closed") throw new Error("That agent is unavailable or archived.");
    if (agent.workspaceId !== workspaceId) throw new Error("That agent belongs to another workspace.");
    if (agent.status !== "idle" || agent.activeTurn || agent.pendingPermissions.length) throw new Error("The agent is busy or waiting on a permission. Send when it is idle.");
    const ids = new Set(input.commentIds);
    // Claim the comments first, so a second click or another client cannot send them twice.
    const { result: picked } = await mutate(workspaceId, (comments, now) => {
      const chosen = comments.filter(comment => ids.has(comment.commentId));
      if (chosen.length !== ids.size || chosen.some(comment => comment.status !== "open" || comment.delivery)) {
        throw new Error("Only unsent comments can be sent. Refresh and try again.");
      }
      for (const comment of chosen) { comment.delivery = { phase: "sending", error: null }; comment.sentTo = input.agentId; comment.updatedAt = now; }
      return chosen.map(comment => ({ ...comment }));
    });
    let error: string | null = null;
    try { await paseo.agents.ref(input.agentId).send(commentMessage(picked, input.workspaceName, input.scopeLabel)); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    const { comments } = await mutate(workspaceId, (all, now) => {
      for (const comment of all) {
        if (!ids.has(comment.commentId) || comment.delivery?.phase !== "sending") continue;
        // A failed send may still have reached the agent, so it stays unconfirmed until the user checks.
        if (error) comment.delivery = { phase: "sending", error };
        else { comment.status = "sent"; comment.sentAt = now; comment.delivery = { phase: "sent", error: null }; }
        comment.updatedAt = now;
      }
    });
    return { comments, error };
  }

  return { list, save, update, send };
}
