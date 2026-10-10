// Live roster updates, without the Paseo client, so tests can load them.

// Directory updates within this window become one refresh.
export const LIVE_DEBOUNCE_MS = 500;
// The Agents panel's refresh when no update arrives, in case the subscription drops quietly.
export const LIVE_BACKSTOP_MS = 30_000;

type Timers = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
const realTimers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/**
 * One agent and workspace subscription per host, shared by every view that shows its agents.
 * listen starts the host's subscriptions and returns their cleanup; refresh reloads the host's roster.
 * Updates within LIVE_DEBOUNCE_MS of the first one become a single refresh. The subscriptions stop
 * when the last view lets go.
 */
export function createLiveRosters(listen: (serverId: string, changed: () => void) => () => void, refresh: (serverId: string) => void, timers: Timers = realTimers) {
  const hosts = new Map<string, { views: number; stop: () => void; timer: unknown }>();
  return function retain(serverId: string): () => void {
    let host = hosts.get(serverId);
    if (!host) {
      const entry: { views: number; stop: () => void; timer: unknown } = { views: 0, stop: () => {}, timer: null };
      entry.stop = listen(serverId, () => {
        if (entry.timer !== null || hosts.get(serverId) !== entry) return;
        entry.timer = timers.set(() => { entry.timer = null; refresh(serverId); }, LIVE_DEBOUNCE_MS);
      });
      hosts.set(serverId, host = entry);
    }
    host.views++;
    let released = false;
    const held = host;
    return () => {
      if (released) return;
      released = true;
      if (--held.views > 0 || hosts.get(serverId) !== held) return;
      hosts.delete(serverId);
      if (held.timer !== null) timers.clear(held.timer);
      held.stop();
    };
  };
}
