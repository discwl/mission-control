export type RunLockInspection = {
  state: "absent" | "legacy" | "unknown" | "owned-unverified";
  revision: string | null;
  fileIdentity: string | null;
  owner: null | { protocol: string; run: string; nonce: string; gateId: string; host: string; pid: number; processInstance: string; acquiredAt: string };
  recovery: string;
};
export class RunLockError extends Error { code: string; actionStarted?: boolean; actionSucceeded?: boolean; actionError?: unknown; cleanupError?: unknown; result?: unknown; }
export function withRunLock<T>(runFolder: string, action: () => Promise<T>): Promise<T>;
export function inspectRunLock(runFolder: string): Promise<RunLockInspection>;
export function recoverRunLock(runFolder: string, input: {expectedRevision: string; expectedFileIdentity: string; expectedNonce: string; actor: string; reason: string}): Promise<{ applied: true; audit: string; revision: string }>;
export const LEGACY_LOCK_MIN_AGE_MS: number;
export function clearLegacyRunLock(runFolder: string, input: {expectedRevision: string; expectedFileIdentity: string; actor: string; reason: string}, now?: () => number): Promise<{ applied: true; audit: string; revision: string }>;
export function runningAgentsInWorkspace(paseo: { agents: { list(options: unknown): Promise<{ entries: readonly { agent: { id: string; title?: string | null; workspaceId?: string | null; status: string; archivedAt?: string | null } }[]; pageInfo: { hasMore?: boolean; nextCursor?: string | null } }> } }, workspaceId: string, exclude?: string | null): Promise<string[]>;
