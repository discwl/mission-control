import type { CommentAnchor, DiffLine, ReviewComment, ReviewFile } from "../shared/review";

export const anchorKey = (side: "old" | "new", line: number) => `${side}:${line}`;

/** The anchor for a comment on one diff line. Context lines anchor to the current code. */
export function anchorFor(line: DiffLine, contentId: string, side?: "old" | "new"): CommentAnchor | null {
  const chosen = side ?? (line.kind === "del" ? "old" : "new");
  const number = chosen === "old" ? line.old : line.new;
  return number ? { side: chosen, line: number, contentId, text: line.text } : null;
}

export type Placement = {
  // Comments shown under a line, keyed by anchorKey of the line where they now sit.
  byLine: Map<string, ReviewComment[]>;
  fileLevel: ReviewComment[];
  // The anchored line's text is gone from this file's changes.
  outdated: ReviewComment[];
};

/**
 * Places unresolved comments for one file. A comment stays on its line while the text still
 * matches, follows the same text if lines shifted (preferring its original change block), and
 * is reported as outdated when the text is no longer in the diff. Nothing is ever dropped.
 */
export function placeComments(file: ReviewFile, comments: ReviewComment[]): Placement {
  const placement: Placement = { byLine: new Map(), fileLevel: [], outdated: [] };
  const lines = file.hunks.flatMap(hunk => hunk.lines.map(line => ({ line, contentId: hunk.contentId })));
  const add = (key: string, comment: ReviewComment) => placement.byLine.set(key, [...(placement.byLine.get(key) ?? []), comment]);
  for (const comment of comments) {
    if (comment.path !== file.path || comment.status === "resolved") continue;
    const anchor = comment.anchor;
    if (!anchor) { placement.fileLevel.push(comment); continue; }
    const numberOf = (line: DiffLine) => (anchor.side === "old" ? line.old : line.new);
    const exact = lines.find(({ line }) => numberOf(line) === anchor.line && line.text === anchor.text && line.kind !== "meta");
    if (exact) { add(anchorKey(anchor.side, anchor.line), comment); continue; }
    const sameText = lines.filter(({ line }) => numberOf(line) !== null && line.text === anchor.text && line.kind !== "meta");
    const best = sameText.find(item => item.contentId === anchor.contentId)
      ?? [...sameText].sort((a, b) => Math.abs(numberOf(a.line)! - anchor.line) - Math.abs(numberOf(b.line)! - anchor.line))[0];
    if (best && anchor.text.trim()) add(anchorKey(anchor.side, numberOf(best.line)!), comment);
    else placement.outdated.push(comment);
  }
  return placement;
}

/** Comment keys a diff row can show: both sides for context lines. */
export function rowKeys(line: DiffLine | null, side?: "old" | "new"): string[] {
  if (!line || line.kind === "meta") return [];
  const keys: string[] = [];
  if (line.old !== null && side !== "new") keys.push(anchorKey("old", line.old));
  if (line.new !== null && side !== "old") keys.push(anchorKey("new", line.new));
  return keys;
}
