import { link, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { launchReceiptSchema, RECEIPT_KEEP_MS, type LaunchReceipt, type LaunchStep } from "../shared/stage-launch";
export { launchHadEffects } from "../shared/stage-launch";

/** <PASEO_HOME>/plugin-data/mission-control/stage-launches, one file per stage start request. */
export const stageLaunchDirectory = () => join(process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo"), "plugin-data", "mission-control", "stage-launches");
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
// Windows refuses a rename or read for a moment while another process (a scanner, an indexer) has the file open.
const busy = (error: unknown) => ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "");


/**
 * Durable receipts for stage starts on this host. Paseo stops waiting for a plugin call after 30 seconds, but a stage
 * start can take longer (inspection, OCR, run start). The coordinating computer asks for the receipt by request ID
 * instead of guessing, and a request ID can only ever start once: a second claim, or a claim after `cancelIfMissing`,
 * finds the existing receipt.
 */
export function createLaunchReceipts(directory = stageLaunchDirectory(), now: () => Date = () => new Date()) {
  // Starts running in this process. After a restart, a receipt still marked running reads as interrupted.
  const live = new Set<string>();
  const file = (requestId: string) => {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new Error("Invalid stage start request ID.");
    return join(directory, `${requestId}.json`);
  };
  async function read(requestId: string): Promise<LaunchReceipt | null> {
    for (let attempt = 0; ; attempt++) {
      let text: string;
      try { text = await readFile(file(requestId), "utf8"); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return null;
        // Windows can refuse a read for a moment while a replacement is renamed into place.
        if (busy(error) && attempt < 4) { await pause(); continue; }
        throw error;
      }
      const parsed = launchReceiptSchema.safeParse((() => { try { return JSON.parse(text); } catch { return null; } })());
      if (parsed.success) return parsed.data;
      // Receipts are written whole and renamed or linked into place, so this shouldn't happen. If it does, the start
      // may have done anything: never report it as missing or harmless.
      const at = now().toISOString();
      return { requestId, phase: "running", step: "sending", agentId: null, runId: null, error: "This start's receipt couldn't be read.", startedAt: at, updatedAt: at };
    }
  }
  /** Writes a complete file beside the target, then links it into place only if no receipt exists yet. */
  async function create(receipt: LaunchReceipt): Promise<boolean> {
    const target = file(receipt.requestId);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.${receipt.requestId}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(receipt), { flag: "wx" });
    try { await link(temporary, target); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async function replace(receipt: LaunchReceipt) {
    const target = file(receipt.requestId);
    const temporary = join(directory, `.${receipt.requestId}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(receipt), { flag: "wx" });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, target); return; }
      catch (error) {
        if (busy(error) && attempt < 4) { await pause(); continue; }
        await unlink(temporary).catch(() => {});
        throw error;
      }
    }
  }
  function report(receipt: LaunchReceipt | null): LaunchReceipt | null {
    if (!receipt || receipt.phase !== "running" || live.has(receipt.requestId)) return receipt;
    return { ...receipt, phase: "failed", error: `Mission Control on this host restarted while the stage was starting (last step: ${receipt.step}).` };
  }
  const fresh = (requestId: string, phase: LaunchReceipt["phase"]): LaunchReceipt => {
    const at = now().toISOString();
    return { requestId, phase, step: "accepted", agentId: null, runId: null, error: phase === "cancelled" ? "The stage start was cancelled before it reached this host." : null, startedAt: at, updatedAt: at };
  };
  return {
    /** Claims a request ID for a new start. `created: false` returns the receipt an earlier claim or cancel left. */
    async claim(requestId: string): Promise<{ created: boolean; receipt: LaunchReceipt }> {
      const receipt = fresh(requestId, "running");
      // Marked as running here before the receipt exists, so no read in between can mistake it for interrupted. A claim
      // that loses to an existing receipt leaves that start's mark alone.
      const already = live.has(requestId);
      live.add(requestId);
      let created = false;
      try { created = await create(receipt); }
      catch (error) { if (!already) live.delete(requestId); throw error; }
      if (created) return { created: true, receipt };
      if (!already) live.delete(requestId);
      const existing = report(await read(requestId));
      if (!existing) throw new Error("The stage start receipt disappeared while it was claimed.");
      return { created: false, receipt: existing };
    },
    /** Records progress for a start running in this process. */
    async step(requestId: string, step: LaunchStep, detail: { agentId?: string; runId?: string } = {}) {
      const current = await read(requestId);
      if (!current || current.phase !== "running") throw new Error("The stage start receipt is no longer running.");
      await replace({ ...current, step, ...detail, updatedAt: now().toISOString() });
    },
    async finish(requestId: string, result: { phase: "done"; agentId: string; runId: string } | { phase: "failed"; error: string }) {
      // The start stays marked as running here until its final receipt is written, so no read in between can mistake
      // a finished start for one interrupted by a restart.
      try {
        const current = await read(requestId);
        if (current) await replace({ ...current, ...result, ...(result.phase === "done" ? { step: "sent" as const } : {}), updatedAt: now().toISOString() });
      } finally { live.delete(requestId); }
    },
    async status(requestId: string): Promise<LaunchReceipt | null> { return report(await read(requestId)); },
    /** The receipt, or a cancellation that stops a request that never arrived from ever starting later. */
    async cancelIfMissing(requestId: string): Promise<LaunchReceipt> {
      const cancelled = fresh(requestId, "cancelled");
      if (await create(cancelled)) return cancelled;
      const existing = report(await read(requestId));
      if (!existing) throw new Error("The stage start receipt disappeared while it was read.");
      return existing;
    },
    /**
     * Removes receipts last written more than RECEIPT_KEEP_MS ago, except starts still running in this process. A
     * runner asking about a start that old gets a cancellation it won't trust (see cancelledBeforeArrival).
     */
    async prune() {
      let names: string[];
      try { names = await readdir(directory); } catch { return; }
      const cutoff = now().getTime() - RECEIPT_KEEP_MS;
      for (const name of names) {
        const path = join(directory, name);
        try {
          if ((await stat(path)).mtimeMs >= cutoff) continue;
          if (name.endsWith(".json") && live.has(name.slice(0, -5))) continue;
          await rm(path, { force: true });
        } catch { /* A file removed or busy meanwhile is skipped. */ }
      }
    },
  };
}
export type LaunchReceipts = ReturnType<typeof createLaunchReceipts>;
