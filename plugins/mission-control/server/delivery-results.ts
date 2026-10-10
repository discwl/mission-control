import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { deliveryResultSchema, type DeliveryKind, type DeliveryResult } from "../shared/pull-request";
import { hideCredentials } from "../shared/secret-mask";

type ResultOf<K extends DeliveryKind> = NonNullable<Extract<DeliveryResult, { kind: K }>["result"]>;
export type Started<R> = { done: true; resultId: string; result: R } | { done: false; resultId: string; step: string; startedAt: string };

// Results by file (null keeps them in memory only), shared across module reloads like the merge locks, so a
// merge or pull request that outlives its reply keeps reporting until the user dismisses its card.
const stateKey = Symbol.for("mission-control.delivery-results");
type Store = { entries: Map<string, DeliveryResult>; loaded: boolean; writes: Promise<void> };
const runtime = globalThis as typeof globalThis & { [stateKey]?: { stores: Map<string, Store>; running: Set<string> } };
const state = runtime[stateKey] ??= { stores: new Map(), running: new Set() };

const keep = 50;
// Errors are kept on disk and shown, so key-like strings and URL credentials are hidden first.
const failure = (error: unknown) => hideCredentials(error instanceof Error ? error.message : String(error));

/** <PASEO_HOME>/plugin-data/mission-control/delivery-results.json, beside Setup's install log. */
export function defaultResultsFile() {
  const paseoHome = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return join(paseoHome, "plugin-data", "mission-control", "delivery-results.json");
}

/**
 * Every Merge, Open PR and Clean up started from Attention, with its current step, then its result and each
 * step's outcome. Results stay, on disk too, until dismissed. An entry still running when the plugin's
 * process ended is shown as interrupted, since nothing is following it any more.
 */
export function createDeliveryResults(options: { file: string | null } = { file: null }) {
  const key = options.file ?? ":memory:";
  const store = state.stores.get(key) ?? { entries: new Map(), loaded: options.file === null, writes: Promise.resolve() };
  state.stores.set(key, store);

  async function load() {
    if (store.loaded || !options.file) return;
    store.loaded = true;
    let saved: unknown = [];
    try { saved = JSON.parse(await readFile(options.file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") saved = []; }
    const parsed = z.array(z.unknown()).catch([]).parse(saved);
    for (const item of parsed) {
      const entry = deliveryResultSchema.safeParse(item);
      if (!entry.success || store.entries.has(entry.data.resultId)) continue;
      const value = entry.data;
      if (value.state === "running" && !state.running.has(value.resultId)) {
        Object.assign(value, { state: "failed", finishedAt: value.startedAt, error: `Mission Control restarted while this was at "${value.step}", so its result is unknown. Check the task's repository and task record before trying again.` });
      }
      store.entries.set(value.resultId, value);
    }
  }

  function save() {
    if (!options.file) return Promise.resolve();
    const file = options.file;
    store.writes = store.writes.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify([...store.entries.values()], null, 1)}\n`, { flag: "wx" });
        await rename(temporary, file);
      } catch { await unlink(temporary).catch(() => {}); }
    });
    return store.writes;
  }

  function trim() {
    const finished = [...store.entries.values()].filter(entry => entry.state !== "running").sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const entry of finished.slice(keep)) store.entries.delete(entry.resultId);
  }

  /** Whether any delivery of this task (merge, pull request or cleanup) is running in this process. */
  function running(taskId: string) {
    return [...store.entries.values()].some(entry => entry.taskId === taskId && entry.state === "running" && state.running.has(entry.resultId));
  }

  /**
   * Starts `work` and replies with its result, or, when it outlasts `replyWithinMs`, with where it is. Either
   * way the card stays until dismissed. Callers check running() first, in the same tick.
   */
  async function start<K extends DeliveryKind>(kind: K, taskId: string, taskTitle: () => Promise<string>, work: (report: (step: string) => void) => Promise<ResultOf<K>>, replyWithinMs: number): Promise<Started<ResultOf<K>>> {
    // Registered before the first await, so running(taskId) is true for any call that checks after this one.
    const entry = { kind, resultId: randomUUID(), taskId, taskTitle: taskId, startedAt: new Date().toISOString(), step: "Checking", state: "running", finishedAt: null, error: null, result: null } as Extract<DeliveryResult, { kind: K }>;
    store.entries.set(entry.resultId, entry);
    state.running.add(entry.resultId);
    // Earlier results are read in before the first save, so saving never drops them.
    await load();
    void save();
    const finish = (patch: Partial<DeliveryResult>) => {
      Object.assign(entry, patch, { finishedAt: new Date().toISOString() });
      state.running.delete(entry.resultId);
      trim();
      void save();
    };
    const task = (async () => {
      entry.taskTitle = await taskTitle().catch(() => taskId);
      return work(step => { entry.step = step; void save(); });
    })();
    task.then(result => finish({ state: "finished", result } as Partial<DeliveryResult>), error => finish({ state: "failed", error: failure(error) }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>(done => { timer = setTimeout(() => done(null), replyWithinMs); });
    try {
      const finished: { value: ResultOf<K> } | null = await Promise.race([task.then(value => ({ value })), late]);
      return finished ? { done: true, resultId: entry.resultId, result: finished.value } : { done: false, resultId: entry.resultId, step: entry.step, startedAt: entry.startedAt };
    } finally { clearTimeout(timer); }
  }

  /** Running and finished results, newest first. */
  async function list(): Promise<DeliveryResult[]> {
    await load();
    return [...store.entries.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(entry => structuredClone(entry));
  }

  /** Forgets a finished result once seen; a running one stays. */
  async function dismiss(resultId: string): Promise<boolean> {
    await load();
    const entry = store.entries.get(resultId);
    if (!entry || entry.state === "running") return false;
    store.entries.delete(resultId);
    await save();
    return true;
  }

  return { start, running, list, dismiss, load };
}
export type DeliveryResults = ReturnType<typeof createDeliveryResults>;
