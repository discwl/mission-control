// A Review or Attention bubble asks its workspace's Host agents tab to open that dialog. The tab may not be
// mounted yet, so the request waits here until the tab takes it.

export type HostDialog = "review" | "attention";

type HostDestination = { serverId: string; kind: "agent" | "workspace"; id: string };
const destinations = new Map<string, HostDestination>();

// Button contributions in Paseo 0.12 don't receive native navigation. Only an explicit destination
// action mounts Host agents to use its navigation; opening or closing the dialog never does.
export function requestHostDestination(workspaceId: string, destination: HostDestination) {
  destinations.set(workspaceId, destination);
  version++;
  for (const listener of [...listeners]) listener();
}

export function takeHostDestination(workspaceId: string, serverId: string): HostDestination | null {
  const destination = destinations.get(workspaceId);
  destinations.delete(workspaceId);
  return destination?.serverId === serverId ? destination : null;
}

const pending = new Map<string, HostDialog>();
const listeners = new Set<() => void>();
let version = 0;

export function requestHostDialog(workspaceId: string, dialog: HostDialog) {
  pending.set(workspaceId, dialog);
  version++;
  for (const listener of [...listeners]) listener();
}

export function requestHostReview(workspaceId: string) {
  requestHostDialog(workspaceId, "review");
}

export function requestHostAttention(workspaceId: string) {
  requestHostDialog(workspaceId, "attention");
}

/** The dialog to open, once per request; null when there is none. The latest request wins. */
export function takeHostDialogRequest(workspaceId: string): HostDialog | null {
  const dialog = pending.get(workspaceId) ?? null;
  pending.delete(workspaceId);
  return dialog;
}

/** True once per Review request. */
export function takeHostReviewRequest(workspaceId: string): boolean {
  if (pending.get(workspaceId) !== "review") return false;
  pending.delete(workspaceId);
  return true;
}

export function subscribeHostReviewRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function hostReviewRequestVersion(): number {
  return version;
}
