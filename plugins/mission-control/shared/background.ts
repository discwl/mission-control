// Paseo 0.12 leaves background workspaces, and every agent in them, out of agent and workspace lists unless the
// filter sets includeBackground. Hosts before 0.12 don't know the field and drop it. A 0.12 client refuses it for
// an older host instead ("Update the host to use background workspaces."), so that host is asked again without
// it, and not asked with it for the next ten minutes.

const retryAfterMs = 10 * 60_000;
const refusedAt = new Map<string, number>();

/** The refusal key for lists through the installation's own host: the client's `paseo`, or a handler's. */
export const ownHost = "own-host";

export function refusesBackground(error: unknown): boolean {
  return /update the host to use background workspaces/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * Runs one list call with `filter` plus includeBackground, or with `filter` alone for a host that refuses the field.
 * `host` keys the refusal: a server ID, or any fixed name for the installation's own host.
 */
export async function listIncludingBackground<Filter extends object, Result>(host: string, filter: Filter, list: (filter: Filter) => Promise<Result>, now: () => number = Date.now): Promise<Result> {
  const refused = refusedAt.get(host);
  if (refused !== undefined && now() - refused < retryAfterMs) return list(filter);
  // The SDK types Mission Control builds against predate the field.
  try { return await list({ ...filter, includeBackground: true } as Filter); }
  catch (error) {
    if (!refusesBackground(error)) throw error;
    refusedAt.set(host, now());
    return list(filter);
  }
}
