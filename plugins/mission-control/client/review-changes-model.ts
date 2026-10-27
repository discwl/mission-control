import { z } from "zod";
import type { ReviewSnapshot } from "../shared/review";

export const reviewBaselineSchema = z.object({
  version: z.literal(1), identity: z.string(), at: z.string(), fingerprint: z.string(),
  scope: z.string(), partial: z.boolean(),
  files: z.array(z.object({ path: z.string(), oldPath: z.string().nullable(), change: z.string(), ids: z.array(z.string()), additions: z.number(), deletions: z.number() })).max(5000),
});
export type ReviewBaseline = z.infer<typeof reviewBaselineSchema>;
// A HEAD comparison has a moving base. A since/commit comparison can advance HEAD safely.
export function reviewComparisonScope(snapshot: ReviewSnapshot): string {
  return JSON.stringify([snapshot.repoRoot, snapshot.branch, snapshot.base, snapshot.fromCommit?.sha ?? null, snapshot.sinceCommit?.sha ?? null, snapshot.base === "head" ? snapshot.head : null]);
}
export function makeReviewBaseline(identity: string, snapshot: ReviewSnapshot): ReviewBaseline {
  return { version: 1, identity, at: snapshot.generatedAt, fingerprint: snapshot.fingerprint, scope: reviewComparisonScope(snapshot),
    partial: Boolean(snapshot.omittedFiles || snapshot.baseWarning || snapshot.files.length > 5000 || snapshot.files.some(file => file.truncated)),
    files: snapshot.files.slice(0, 5000).map(file => ({ path: file.path, oldPath: file.oldPath, change: file.change, ids: [...file.reviewIds].sort(), additions: file.additions, deletions: file.deletions })) };
}
export function restoreReviewBaseline(value: unknown, identity: string): ReviewBaseline | null {
  const parsed = reviewBaselineSchema.safeParse(value);
  return parsed.success && parsed.data.identity === identity ? parsed.data : null;
}
export function compareReviewBaseline(baseline: ReviewBaseline | null, identity: string, snapshot: ReviewSnapshot) {
  const empty = { added: [] as string[], changed: [] as string[], removed: [] as string[], unchanged: 0, newParts: 0, partial: false };
  if (!baseline || baseline.identity !== identity) return { ...empty, state: "missing" as const };
  if (baseline.scope !== reviewComparisonScope(snapshot)) return { ...empty, state: "scope-changed" as const };
  const current = makeReviewBaseline(identity, snapshot);
  const oldFiles = new Map(baseline.files.map(file => [file.path, file]));
  const paths = new Set(current.files.map(file => file.path));
  const result = { ...empty, state: "comparable" as const, partial: baseline.partial || current.partial };
  for (const file of current.files) {
    const previous = oldFiles.get(file.path);
    if (!previous) { result.added.push(file.path); result.newParts += file.ids.length; }
    else if (JSON.stringify(previous) !== JSON.stringify(file)) {
      result.changed.push(file.path);
      result.newParts += file.ids.filter(id => !previous.ids.includes(id)).length;
    } else result.unchanged++;
  }
  result.removed = baseline.files.filter(file => !paths.has(file.path)).map(file => file.path);
  return result;
}
