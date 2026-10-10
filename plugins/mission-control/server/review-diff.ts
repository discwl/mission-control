import { createHash } from "node:crypto";
import type { DiffLine, ReviewFile, ReviewHunk } from "../shared/review";
import { classifyHunk, maxSeverity } from "./review-rules";

// Structure adapted from Review Deck's DiffParser (MIT, github.com/mentalfl0w/review-deck).
// Differences: hunk bodies are bounded by the header's line counts, so trailing blank
// lines and "\ No newline" markers never shift numbering, and zero-hunk files keep a kind.

const maxLinesPerFile = 4000;

function unquote(value: string): string {
  if (!value.startsWith("\"")) return value;
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, "\"": 34, "\\": 92 };
  for (let index = 1; index < value.length - 1; index++) {
    const char = value[index];
    if (char !== "\\") { bytes.push(...Buffer.from(char, "utf8")); continue; }
    const octal = /^[0-7]{3}/.exec(value.slice(index + 1));
    if (octal) { bytes.push(parseInt(octal[0], 8)); index += 3; continue; }
    bytes.push(escapes[value[index + 1]] ?? value.charCodeAt(index + 1));
    index++;
  }
  return Buffer.from(bytes).toString("utf8");
}

function headerPaths(line: string): { oldPath: string; path: string } | null {
  const rest = line.slice("diff --git ".length);
  const strip = (value: string) => unquote(value).replace(/^[ab]\//, "");
  const quoted = /^("a\/(?:[^"\\]|\\.)*"|a\/.+?) ("b\/(?:[^"\\]|\\.)*")$/.exec(rest) ?? /^("a\/(?:[^"\\]|\\.)*") (b\/.+)$/.exec(rest);
  if (quoted) return { oldPath: strip(quoted[1]), path: strip(quoted[2]) };
  // Unquoted paths may contain spaces. Same-path headers split evenly; renames are
  // corrected later from the "rename from/to" lines.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.startsWith("a/") && rest.slice(half + 1).startsWith("b/") && rest.slice(2, half) === rest.slice(half + 3)) {
    return { oldPath: rest.slice(2, half), path: rest.slice(half + 3) };
  }
  const plain = /^a\/(.+?) b\/(.+)$/.exec(rest);
  return plain ? { oldPath: plain[1], path: plain[2] } : null;
}

export function contentId(path: string, body: string[]): string {
  return createHash("sha256").update(path).update("\0").update(body.join("\n")).digest("hex").slice(0, 16);
}

type Draft = { path: string; oldPath: string | null; change: ReviewFile["change"]; hunks: ReviewHunk[]; lineCount: number; truncated: boolean };

export function parseDiff(raw: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  const lines = raw.split(/\r?\n/);
  let file: Draft | null = null;
  let index = 0;

  const finish = () => {
    if (!file) return;
    const additions = file.hunks.reduce((sum, hunk) => sum + hunk.additions, 0);
    const deletions = file.hunks.reduce((sum, hunk) => sum + hunk.deletions, 0);
    const severity = file.change === "binary" ? "low" : maxSeverity(file.hunks.map(hunk => hunk.severity));
    const reasons = [...new Set(file.hunks.flatMap(hunk => hunk.reasons))];
    const reviewIds = file.hunks.length ? file.hunks.map(hunk => hunk.contentId) : [contentId(file.path, ["file", file.change, file.oldPath ?? ""])];
    files.push({ path: file.path, oldPath: file.oldPath, change: file.change, additions, deletions, severity,
      reasons: file.change === "binary" ? ["Binary file"] : reasons, hunks: file.hunks, reviewIds, truncated: file.truncated });
    file = null;
  };

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("diff --git ")) {
      finish();
      const paths = headerPaths(line);
      file = paths ? { path: paths.path, oldPath: paths.oldPath !== paths.path ? paths.oldPath : null, change: "modified", hunks: [], lineCount: 0, truncated: false } : null;
      index++;
      continue;
    }
    if (!file) { index++; continue; }
    if (line.startsWith("new file mode")) file.change = "added";
    else if (line.startsWith("deleted file mode")) file.change = "deleted";
    else if (line.startsWith("rename to ")) { file.change = "renamed"; file.path = unquote(line.slice("rename to ".length)); }
    else if (line.startsWith("rename from ")) file.oldPath = unquote(line.slice("rename from ".length));
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.change = "binary";
    const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (!range) { index++; continue; }
    const oldStart = Number(range[1]);
    const newStart = Number(range[3]);
    let oldLeft = Number(range[2] ?? 1);
    let newLeft = Number(range[4] ?? 1);
    let oldNo = oldStart;
    let newNo = newStart;
    const body: string[] = [];
    const diffLines: DiffLine[] = [];
    index++;
    while (index < lines.length && (oldLeft > 0 || newLeft > 0 || lines[index].startsWith("\\"))) {
      const text = lines[index];
      if (text.startsWith("\\")) diffLines.push({ kind: "meta", old: null, new: null, text: text.slice(2) });
      else if (text.startsWith("+")) { diffLines.push({ kind: "add", old: null, new: newNo++, text: text.slice(1) }); newLeft--; }
      else if (text.startsWith("-")) { diffLines.push({ kind: "del", old: oldNo++, new: null, text: text.slice(1) }); oldLeft--; }
      else if (text.startsWith(" ") || text === "") { diffLines.push({ kind: "context", old: oldNo++, new: newNo++, text: text.slice(1) }); oldLeft--; newLeft--; }
      else break;
      body.push(text);
      index++;
    }
    const { severity, reasons } = classifyHunk(file.path, body);
    const kept = file.lineCount >= maxLinesPerFile ? [] : diffLines.slice(0, maxLinesPerFile - file.lineCount);
    if (kept.length < diffLines.length) file.truncated = true;
    file.lineCount += kept.length;
    file.hunks.push({
      contentId: contentId(file.path, body), header: line.slice(0, line.indexOf("@@", 2) + 2), context: range[5]?.trim() || null,
      oldStart, newStart, additions: diffLines.filter(item => item.kind === "add").length, deletions: diffLines.filter(item => item.kind === "del").length,
      severity, reasons, lines: kept,
    });
  }
  finish();
  return files;
}
