import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { rename } from "./retrying-rename";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import type { ReviewFile } from "../shared/review";

const maxMarks = 5000;
const fileSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string(),
  marks: z.record(z.string(), z.string()),
  from: z.string().nullable().default(null),
  since: z.string().nullable().default(null),
  branchBase: z.string().nullable().default(null),
});
type ReviewState = { marks: Record<string, string>; from: string | null; since: string | null; branchBase: string | null };

/** Files still to review: at least one of their review IDs has no mark. */
export function countToReview(files: ReviewFile[], marks: Record<string, string>) {
  return files.filter(file => !file.reviewIds.every(id => marks[id])).length;
}

/** The vault's internal review folder, created on first use. */
export async function reviewFolder(vaultRoot: string) {
  const root = await realpath(vaultRoot);
  const folder = join(root, ".mission-control", "reviews");
  await mkdir(folder, { recursive: true });
  const resolved = await realpath(folder);
  const inside = relative(root, resolved);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("Review data must stay inside the vault.");
  return resolved;
}

export function checkWorkspaceId(workspaceId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) throw new Error("Invalid workspace ID.");
}

/** Serializes writers per key; a failed write must not block the next one. */
export function createQueue() {
  const queues = new Map<string, Promise<unknown>>();
  return <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    queues.set(key, next);
    return next;
  };
}

export async function writeAtomic(file: string, content: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

// Marks are keyed by content hash, so they survive unrelated edits and line shifts and
// lapse on their own when a block's content changes. Stored in the vault's internal folder.
export function createReviewMarkStore(vaultRoot: string) {
  const enqueue = createQueue();

  async function fileFor(workspaceId: string) {
    checkWorkspaceId(workspaceId);
    return join(await reviewFolder(vaultRoot), `${workspaceId}.json`);
  }

  async function read(workspaceId: string): Promise<ReviewState> {
    const file = await fileFor(workspaceId);
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { marks: {}, from: null, since: null, branchBase: null }; throw error; }
    const parsed = fileSchema.parse(JSON.parse(text));
    if (parsed.workspaceId !== workspaceId) throw new Error("Review marks belong to another workspace.");
    return { marks: parsed.marks, from: parsed.from, since: parsed.since, branchBase: parsed.branchBase };
  }

  function update(workspaceId: string, change: (state: ReviewState) => void) {
    return enqueue(workspaceId, async () => {
      const state = await read(workspaceId);
      change(state);
      state.marks = Object.fromEntries(Object.entries(state.marks).sort((a, b) => b[1].localeCompare(a[1])).slice(0, maxMarks));
      await writeAtomic(await fileFor(workspaceId), JSON.stringify({ schemaVersion: 1, workspaceId, marks: state.marks, from: state.from, since: state.since, branchBase: state.branchBase }));
      return state;
    });
  }

  function set(workspaceId: string, ids: string[], reviewed: boolean) {
    const now = new Date().toISOString();
    return update(workspaceId, state => { for (const id of ids) { if (reviewed) state.marks[id] = now; else delete state.marks[id]; } });
  }

  // Only one comparison applies at a time, so choosing one clears the other.
  function setFrom(workspaceId: string, from: string | null) {
    return update(workspaceId, state => { state.from = from; state.since = null; });
  }

  function setSince(workspaceId: string, since: string | null) {
    return update(workspaceId, state => { state.since = since; state.from = null; });
  }

  /** A new task worktree reviews everything since it branched, and remembers that point. */
  function setBranchBase(workspaceId: string, commit: string) {
    return update(workspaceId, state => { state.branchBase = commit; state.since = commit; state.from = null; });
  }

  /** Forgets every mark and comparison of a workspace, for example once its task is merged. */
  function clear(workspaceId: string) {
    return enqueue(workspaceId, async () => {
      await unlink(await fileFor(workspaceId)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    });
  }

  return { read, set, setFrom, setSince, setBranchBase, clear };
}
