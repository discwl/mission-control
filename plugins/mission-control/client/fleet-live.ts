import * as pluginClient from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { fleetChanges } from "../shared/fleet";

type Change = { observedAt: string };

// Paseo 0.16 apps export useSubscription; older apps don't. The choice is fixed for the app's lifetime, so the hook
// below always calls the same hooks in the same order.
const useSubscription = (pluginClient as Partial<typeof pluginClient>).useSubscription;
const contract = fleetChanges;
const useChanges: (onEvent: (event: Change) => void) => { status: string } | null = useSubscription && contract
  ? onEvent => useSubscription(contract, {}, onEvent)
  : () => null;

const observedAt = (value: unknown) => (value as { observedAt?: string } | undefined)?.observedAt ?? "";
// One cached read in flight per query key, shared by every live view on that key (a screen and its sidebar item).
const inFlight = new Map<string, Promise<unknown>>();
// The newest snapshot a push announced, per key, so a shared read that came back older is followed by one more.
const announced = new Map<string, string>();
// When a failed cached read last made the query re-read itself, per key. The forced read that follows makes the host
// push again, so without a limit a device whose reads keep failing would drive forced reads back to back.
const recovered = new Map<string, number>();

/**
 * Keeps a fleet view current from the host's pushes (Paseo 0.16 host and app). While live, every push, and a one-minute
 * backstop, update the view's data with `readCached`, a read that reuses the snapshot the server's own 30-second check
 * took. A push about a snapshot the view already has reads nothing, a cached read never replaces newer data, and a shared
 * read that came back older than the push announced is followed by one more. If a cached read fails, the query re-reads
 * itself (at most once a minute, and not while it already shows an error), so the view shows the failure. The view's own query still
 * forces a read of every host for everything else: the first load, refresh buttons and refetches after the user acts.
 * Returns true while live, so the view can stop its 20-second forced polling; on older Paseo, or while the subscription
 * connects or fails, it returns false and nothing changes.
 */
export function useFleetLive<T>(queryKey: readonly unknown[], readCached: () => Promise<T>): boolean {
  const cache = useQueryClient();
  const reader = useRef(readCached); reader.current = readCached;
  const key = useRef(queryKey); key.current = queryKey;
  const update = useRef((event?: Change, again = false) => {
    const id = JSON.stringify(key.current);
    if (event) {
      if (observedAt(cache.getQueryData(key.current)) >= event.observedAt) return;
      if ((announced.get(id) ?? "") < event.observedAt) announced.set(id, event.observedAt);
    }
    let read = inFlight.get(id) as Promise<T> | undefined;
    if (!read) { read = reader.current(); inFlight.set(id, read); void read.finally(() => inFlight.delete(id)).catch(() => {}); }
    void read.then(
      data => {
        cache.setQueryData(key.current, (previous: unknown) => previous && observedAt(previous) > observedAt(data) ? previous : data);
        const wanted = announced.get(id);
        if (!wanted || observedAt(data) >= wanted) announced.delete(id);
        // A read already in flight when the push came can predate it: read once more for the announced snapshot.
        else if (!again) update.current(undefined, true);
      },
      () => {
        const last = recovered.get(id) ?? 0;
        if (cache.getQueryState?.(key.current)?.status === "error" || Date.now() - last < 60_000) return;
        recovered.set(id, Date.now());
        void cache.invalidateQueries({ queryKey: key.current });
      },
    );
  });
  const live = useChanges(event => update.current(event))?.status === "live";
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => update.current(), 60_000);
    return () => clearInterval(timer);
  }, [live]);
  return live;
}
