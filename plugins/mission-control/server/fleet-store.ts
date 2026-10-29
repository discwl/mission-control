import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fleetStateSchema, type FleetState, type FleetEvent } from "../shared/fleet";

export const fleetStateFile = () => join(process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo"), "plugin-data", "mission-control", "fleet.json");
export const emptyFleetState = (): FleetState => ({ schemaVersion: 1, revision: 0, paused: false, coordinators: [], queue: [], events: [], stoppedAgentIds: [], seen: {}, pipelines: [], agentPolicies: [] });
export function fleetEvent(state: FleetState, event: Omit<FleetEvent, "id" | "at">, now = new Date().toISOString()) {
  state.events.unshift({ ...event, id: randomUUID(), at: now });
  state.events = state.events.slice(0, 500);
}

export function createFleetStore(file = fleetStateFile()) {
  let chain: Promise<unknown> = Promise.resolve();
  async function load(): Promise<FleetState> {
    try { return fleetStateSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFleetState(); throw new Error(`Orchestrator state cannot be read; automatic dispatch is stopped. ${error instanceof Error ? error.message : String(error)}`); }
  }
  return {
    async read() { await chain; return load(); },
    update(change: (state: FleetState) => void | Promise<void>, expectedRevision?: number): Promise<FleetState> {
      const run = async () => {
        await mkdir(dirname(file), { recursive: true });
        // Exclude another plugin subprocess. Never steal a lock after a crash.
        let lock;
        try { lock = await open(`${file}.lock`, "wx", 0o600); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Orchestrator state is locked by another writer. If a plugin crashed, inspect its pending dispatch and fleet.json.lock before restarting automatic work."); throw error; }
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
          const state = await load();
          if (expectedRevision !== undefined && state.revision !== expectedRevision) throw new Error("Orchestrator state changed. Refresh and try again.");
          await change(state);
          state.revision++;
          const validated = fleetStateSchema.parse(state);
          const output = await open(temporary, "wx", 0o600);
          try { await output.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8"); await output.sync(); } finally { await output.close(); }
          await rename(temporary, file);
          return validated;
        } finally {
          try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[mission-control] could not remove temporary fleet state"); }
          await lock.close(); await unlink(`${file}.lock`);
        }
      };
      const result = chain.then(run, run); chain = result.catch(() => {}); return result;
    },
  };
}
export type FleetStore = ReturnType<typeof createFleetStore>;
