// Page position belongs to this client/installation, never to shared host settings.
// It survives surface navigation; reloading the plugin starts a new session.
export function createPageMemory() {
  const values = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    read<T>(key: string, initial: T | (() => T)): T {
      if (!values.has(key)) values.set(key, typeof initial === "function" ? (initial as () => T)() : initial);
      return values.get(key) as T;
    },
    write<T>(key: string, next: T) {
      if (Object.is(values.get(key), next)) return;
      values.set(key, next);
      listeners.get(key)?.forEach(listener => listener());
    },
    subscribe(key: string, listener: () => void) {
      let subscriptions = listeners.get(key);
      if (!subscriptions) { subscriptions = new Set(); listeners.set(key, subscriptions); }
      subscriptions.add(listener);
      return () => { subscriptions.delete(listener); if (!subscriptions.size) listeners.delete(key); };
    },
  };
}

export const pageMemory = createPageMemory();
export function pageKey(...parts: string[]): string { return JSON.stringify(parts); }
