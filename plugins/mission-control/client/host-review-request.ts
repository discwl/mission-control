// A Review bubble asks its workspace's Host agents tab to open the review list. The tab may not be
// mounted yet, so the request waits here until the tab takes it.

const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

export function requestHostReview(workspaceId: string) {
  pending.add(workspaceId);
  version++;
  for (const listener of [...listeners]) listener();
}

/** True once per request: the tab that takes it opens the review list. */
export function takeHostReviewRequest(workspaceId: string): boolean {
  return pending.delete(workspaceId);
}

export function subscribeHostReviewRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function hostReviewRequestVersion(): number {
  return version;
}
