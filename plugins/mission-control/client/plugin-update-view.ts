import { updateLogName } from "../shared/plugin-updates";

export const updateTimeoutMessage = "Mission Control didn't report back within 5 minutes.";
export const updateLogHint = `Check for updates to see which version is installed. For details, open %TEMP%\\${updateLogName} on this host.`;

/**
 * Whether a check's `updating` starts following an update. A check made before the last time-out is
 * the one that timed out, so it can't start the same wait again.
 */
export function followsUpdate(updating: boolean | undefined, checkedAt: number, timedOutAt: number | null) {
  return Boolean(updating) && (timedOutAt === null || checkedAt > timedOutAt);
}

/** The "Last update didn't finish" message, or null when the row is hidden. */
export function lastUpdateNotice(input: { updating: boolean; checking: boolean; lastUpdateError: string | null | undefined; timedOutAt: number | null; checkedAt: number }): string | null {
  // While a check runs, the result it replaces may be stale.
  if (input.updating || input.checking) return null;
  if (input.lastUpdateError) return input.lastUpdateError;
  // A check that finished after the time-out shows the real state instead.
  return input.timedOutAt !== null && input.checkedAt <= input.timedOutAt ? updateTimeoutMessage : null;
}
