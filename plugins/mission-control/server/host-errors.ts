import { isRequestTimeout, requestTimeoutText } from "../shared/request-timeout";

/**
 * Errors that mean a host, or its Mission Control, was briefly out of reach: a plugin reload or deploy, a Paseo
 * restart or upgrade (plugins load before the daemon accepts connections), a slow answer past Paseo's 30-second
 * plugin-call limit, or a dropped relay connection. None of them says anything about the task itself.
 */
// Paseo's and Mission Control's own phrases only: a bare "timed out" raised inside a handler isn't a host hiccup.
const tooSlow = "it answered too slowly";
const transient: readonly (readonly [RegExp, string])[] = [
  [/Plugin is not available: |Plugin stopped: |Plugin process exited: /, "its Mission Control was restarting"],
  [/Paseo is still starting|Server not ready/, "Paseo was starting"],
  [requestTimeoutText, tooSlow],
  [/Timed out waiting for connection|Connection timed out|Ping timed out|did not respond within \d+ seconds/, tooSlow],
  [/Transport closed|Cannot reach host|host_offline|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|Received network error|non-101 status/, "the connection dropped"],
  [/A complete task snapshot is required/, "its task records were still loading"],
];

export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** A plain reason when the error is one of the transient kinds above, otherwise null. */
export function transientHostError(error: unknown): string | null {
  if (isRequestTimeout(error)) return tooSlow;
  const text = errorText(error);
  return transient.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}
