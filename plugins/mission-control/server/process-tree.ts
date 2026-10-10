import { spawn } from "node:child_process";
import { basename, join } from "node:path";

export type ProcessResult = { code: number; stdout: string; stderr: string };
export type ProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  timeoutMs: number;
  maxBuffer?: number;
  // Written to the process's standard input, which is then closed.
  input?: string;
};

/**
 * The process ran past its time limit and was stopped. `confirmed` says whether it and every process it
 * started are known to be gone: the tree kill succeeded and the process closed. When it is false, the work
 * may still be running, so the caller must treat the state it left as unknown rather than clean up after it.
 */
export class ProcessStopped extends Error {
  constructor(readonly file: string, readonly timeoutMs: number, readonly confirmed: boolean) {
    super(`${basename(file)} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped${confirmed ? "" : ", but Mission Control couldn't confirm that it and the processes it started have ended"}`);
  }
}

// After the tree is ended, how long to wait for the process to close before giving up on confirming it.
const settleMs = 10_000;

// Tests only: replaces the tree kill, to simulate one that can't be confirmed.
export const processTreeTesting: { kill: ((pid: number) => Promise<boolean>) | null } = { kill: null };

/**
 * Ends a process and everything it started, and says whether that is confirmed. On Windows `git` is often Git's
 * cmd\git.exe launcher, which runs the real git as a child (and git runs hooks and merge drivers as its
 * children), so ending only the launcher would leave the real work running. taskkill /T ends the whole tree
 * and succeeds only when it found it; elsewhere the child leads its own process group, which SIGKILL ends.
 */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  if (platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); return Promise.resolve(true); }
    // No such group: everything in it has already exited.
    catch (error) { return Promise.resolve((error as NodeJS.ErrnoException).code === "ESRCH"); }
  }
  const taskkill = join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", "taskkill.exe");
  return new Promise(done => {
    const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => done(false));
    killer.on("close", code => done(code === 0));
  });
}

/**
 * Runs an executable without a shell. At `timeoutMs` it ends the process tree and waits for the process to
 * close, then rejects with ProcessStopped: confirmed when the tree kill succeeded and the process closed, so
 * whatever the caller checks next is the final state; unconfirmed otherwise. Rejects with the spawn error when
 * the file can't be run; otherwise resolves with the exit code and output.
 */
export function runProcess(file: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd, env: options.env as NodeJS.ProcessEnv | undefined, shell: false, windowsHide: true,
      detached: process.platform !== "win32",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let ending: "timeout" | "overflow" | null = null;
    let settled = false;
    let closed = false;
    child.once("close", () => { closed = true; });
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const end = (reason: "timeout" | "overflow") => {
      if (ending || settled) return;
      ending = reason;
      void (async () => {
        const killed = child.pid ? await (processTreeTesting.kill ?? killTree)(child.pid) : false;
        child.kill("SIGKILL");
        // Wait for the process to close; if it doesn't within settleMs, its end can't be confirmed.
        if (!closed) await new Promise<void>(done => { const wait = setTimeout(done, settleMs); child.once("close", () => { clearTimeout(wait); done(); }); });
        const confirmed = killed && closed;
        finish(() => reject(reason === "timeout" ? new ProcessStopped(file, options.timeoutMs, confirmed)
          : new Error(`${basename(file)} wrote more than ${Math.round(maxBuffer / 1024 / 1024)} MB of output and was stopped.`)));
      })();
    };
    const timer = setTimeout(() => end("timeout"), options.timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBuffer) end("overflow"); else out.push(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { if (err.reduce((total, part) => total + part.length, 0) < maxBuffer) err.push(chunk); });
    child.on("error", error => finish(() => reject(error)));
    child.on("close", (code, signal) => {
      if (ending) return;
      finish(() => {
        if (code === null) reject(new Error(`${basename(file)} was ended by ${signal ?? "a signal"}.`));
        else resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
      });
    });
    if (options.input !== undefined) {
      child.stdin!.on("error", () => { /* The process may exit without reading its input. */ });
      child.stdin!.end(options.input);
    }
  });
}
