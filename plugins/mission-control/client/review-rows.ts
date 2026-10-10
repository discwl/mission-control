import type { DiffLine, ReviewFile, Severity } from "../shared/review";

// Pairing follows Review Deck's derivePairs (MIT, github.com/mentalfl0w/review-deck):
// a run of deletions zips with the following run of additions.

export type SplitRow = { key: string; old: DiffLine | null; new: DiffLine | null; meta: string | null };

export function splitRows(lines: DiffLine[], prefix = ""): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(dels.length, adds.length); index++) {
      rows.push({ key: `${prefix}${rows.length}`, old: dels[index] ?? null, new: adds[index] ?? null, meta: null });
    }
    dels = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.kind === "del") { if (adds.length) flush(); dels.push(line); }
    else if (line.kind === "add") adds.push(line);
    else {
      flush();
      rows.push(line.kind === "meta"
        ? { key: `${prefix}${rows.length}`, old: null, new: null, meta: line.text }
        : { key: `${prefix}${rows.length}`, old: line, new: line, meta: null });
    }
  }
  flush();
  return rows;
}

export const severityLabel: Record<Severity, string> = { high: "HIGH", medium: "MEDIUM", low: "LOW", info: "INFO" };

export function fileGroups(files: ReviewFile[]) {
  const order: Severity[] = ["high", "medium", "low", "info"];
  return order.map(severity => ({ severity, files: files.filter(file => file.severity === severity) })).filter(group => group.files.length > 0);
}

export function splitPath(path: string) {
  const at = path.lastIndexOf("/");
  return at < 0 ? { dir: "", name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}
