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
