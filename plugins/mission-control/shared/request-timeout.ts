/**
 * Paseo's own wording for a request that got no answer in time. Paseo 0.16.1 names the request ("No response to
 * <request type> after <N>ms") and marks the error with the code DAEMON_REQUEST_TIMEOUT; older clients said
 * "Timeout waiting for message (<N>ms)". The daemon's own limit on a plugin call reads "Plugin RPC timed out: ...".
 * Both client and server code use this, so it imports nothing.
 */
export const requestTimeoutText = /Plugin RPC timed out: |Timeout waiting for message|No response to [\w.:-]+ after \d+ ?ms/;

/** True when the error is Paseo reporting that a request went unanswered, by code or by Paseo's wording. */
export function isRequestTimeout(error: unknown): boolean {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "DAEMON_REQUEST_TIMEOUT") return true;
  return requestTimeoutText.test(error instanceof Error ? error.message : String(error));
}
