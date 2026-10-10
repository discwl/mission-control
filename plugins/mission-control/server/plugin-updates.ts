import { execFile, spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { updateLogName, type PluginSource, type PluginUpdateStatus } from "../shared/plugin-updates";
import { missionControlVersion } from "../shared/version";

const executeFile = promisify(execFile);
const PLUGIN_ID = "mission-control";
// Fixed argument lists only: nothing from the client reaches the command line.
const CHECK = ["plugin", "update", PLUGIN_ID, "--check", "--json"];
const APPLY = ["plugin", "update", PLUGIN_ID, "--yes", "--json"];
const OUTCOMES = ["update", "current", "installed-newer", "local", "error"] as const;

/** A finished Paseo CLI command. Paseo exits 1 when an item's outcome is `error`, and still prints its JSON. */
export interface CommandResult {
  code: number | null;
  output: string;
  /** stderr, when kept apart from `output`. A command that fails outright writes its `{"error": …}` object there. */
  errors?: string;
}

export interface PluginUpdaterIo {
  /** Runs the CLI to completion. Rejects only when it could not run at all. */
  run(args: string[]): Promise<CommandResult>;
  /**
   * Starts the update so it outlives this process, which Paseo stops and replaces when the update succeeds.
   * `onExit` runs only if this process is still alive when the CLI finishes, which means the plugin was not replaced.
   */
  start(args: string[], onExit: (result: CommandResult) => void): Promise<void>;
  now(): Date;
}

async function exists(path: string) {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

/** The Paseo CLI. On Windows it is a .cmd launcher, which only cmd.exe can run. */
async function paseoCommand(args: string[]): Promise<{ file: string; args: string[] }> {
  if (process.platform !== "win32") return { file: "paseo", args };
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path");
  const directories = (pathKey ? process.env[pathKey] ?? "" : "").split(delimiter).map(entry => entry.replace(/^"(.*)"$/, "$1"));
  // The desktop app installs its CLI here; the plugin server's PATH may not include it.
  if (process.env.LOCALAPPDATA) directories.push(join(process.env.LOCALAPPDATA, "Programs", "Paseo", "resources", "bin"));
  for (const directory of directories) {
    if (!isAbsolute(directory)) continue;
    const launcher = join(directory, "paseo.cmd");
    if (!await exists(launcher)) continue;
    if (/["%^&|<>]/.test(launcher)) throw new Error("The Paseo CLI path contains characters that cannot be passed to cmd.exe safely.");
    const shell = process.env.ComSpec && isAbsolute(process.env.ComSpec) ? process.env.ComSpec : "C:\\Windows\\System32\\cmd.exe";
    return { file: shell, args: ["/d", "/s", "/c", `""${launcher}" ${args.join(" ")}"`] };
  }
  throw new Error("The Paseo CLI (paseo.cmd) was not found on this host.");
}

export const hostIo: PluginUpdaterIo = {
  async run(args) {
    const command = await paseoCommand(args);
    try {
      const { stdout, stderr } = await executeFile(command.file, command.args, { timeout: 90_000, maxBuffer: 1024 * 1024, windowsHide: true, windowsVerbatimArguments: process.platform === "win32" });
      return { code: 0, output: stdout, errors: stderr };
    } catch (error) {
      const failure = error as { code?: unknown; killed?: boolean; stdout?: unknown; stderr?: unknown };
      if (failure.killed) throw new Error("The Paseo CLI did not answer within 90 seconds.");
      if (typeof failure.code === "number") return { code: failure.code, output: typeof failure.stdout === "string" ? failure.stdout : "", errors: typeof failure.stderr === "string" ? failure.stderr : "" };
      // Node's own message repeats the command line, which includes the user's profile path.
      throw new Error(`The Paseo CLI could not be run${typeof failure.code === "string" ? ` (${failure.code})` : ""}.`);
    }
  },
  async start(args, onExit) {
    const command = await paseoCommand(args);
    // A pipe would close with this process, so the CLI writes to a file this process reads if it is still running.
    const log = join(tmpdir(), updateLogName);
    const fd = openSync(log, "w");
    try {
      const child = spawn(command.file, command.args, { detached: true, stdio: ["ignore", fd, fd], windowsHide: true, windowsVerbatimArguments: process.platform === "win32" });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.once("exit", code => { void readFile(log, "utf8").catch(() => "").then(output => onExit({ code, output })); });
      child.unref();
    } finally { closeSync(fd); }
  },
  now: () => new Date(),
};

const text = (value: unknown) => typeof value === "string" && value ? value : null;

/** Removes user names and passwords from any URL in text shown to the user. */
export function redactUrls(value: string) {
  return value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1");
}

/** Drops any user name or password from a remote URL before it is shown. */
export function displayRemote(remote: string) {
  try {
    const url = new URL(remote);
    if (!url.username && !url.password) return remote;
    url.username = ""; url.password = "";
    return url.toString();
  } catch { return redactUrls(remote); }
}

export function readSource(identity: unknown): PluginSource | null {
  if (!identity || typeof identity !== "object") return null;
  const value = identity as Record<string, unknown>;
  const path = text(value.path), remote = text(value.remote), pluginPath = text(value.pluginPath);
  if (value.kind === "directory") return path ? { kind: "directory", path } : null;
  if (value.kind === "git") return remote ? { kind: "git", remote: displayRemote(remote), pluginPath: pluginPath === "." ? null : pluginPath } : null;
  if (value.kind === "npm") return { kind: "npm", name: text(value.packageName) ?? text(value.package) ?? text(value.name) };
  return text(value.kind) ? { kind: "other", label: text(value.kind)! } : null;
}

type Preview = { id?: unknown; outcome?: unknown; current?: { identity?: unknown; currentRevision?: unknown } | null; target?: { kind?: unknown; commit?: unknown; version?: unknown } | null; links?: unknown; error?: unknown };

/** Finds this plugin's entry in the CLI's JSON list, or null when the output isn't that list. */
function readEntry(output: string): { item: Preview | null } | null {
  const start = output.indexOf("[");
  if (start < 0) return null;
  try {
    const items: unknown = JSON.parse(output.slice(start));
    if (!Array.isArray(items)) return null;
    return { item: items.find((entry: Preview) => entry?.id === PLUGIN_ID) ?? null };
  } catch { return null; }
}

/** The message from the `{"error": {"code", "message", "details"}}` object Paseo writes when a command fails outright. `details` is a stack trace and is never shown. */
function readCliError(output: string): string | null {
  const start = output.search(/\{\s*"error"\s*:/);
  if (start < 0) return null;
  try {
    const error: unknown = JSON.parse(output.slice(start, output.lastIndexOf("}") + 1)).error;
    const message = typeof error === "string" ? error : text((error as { message?: unknown } | null)?.message);
    return message ? redactUrls(message).slice(0, 500) : null;
  } catch { return null; }
}

/** Reads `paseo plugin update mission-control --check --json` output. Anything unexpected is an error, never "up to date". */
export function readCheckOutput(result: CommandResult, checkedAt: string): PluginUpdateStatus {
  const failed = (error: string): PluginUpdateStatus => ({ version: missionControlVersion, source: null, state: "error", current: null, target: null, links: [], checkedAt, error, updating: false, lastUpdateError: null });
  const entry = readEntry(result.output);
  if (!entry) {
    const reason = readCliError(result.errors ?? "") ?? readCliError(result.output);
    if (reason) return failed(`Paseo's update check failed: ${reason}`);
    return failed(result.code ? `Paseo's update check failed (exit code ${result.code}).` : "Paseo returned an update check that could not be read.");
  }
  const item = entry.item;
  if (!item) return failed("Paseo did not report Mission Control in its update check.");
  const state = OUTCOMES.find(value => value === item.outcome) ?? "error";
  const error = state !== "error" ? null
    : redactUrls(text(item.error) ?? (OUTCOMES.includes(item.outcome as never) ? "The update check failed." : `Unknown update outcome: ${String(item.outcome)}`));
  return {
    version: missionControlVersion,
    source: readSource(item.current?.identity),
    state, checkedAt, error,
    current: text(item.current?.currentRevision),
    target: text(item.target?.kind === "git" ? item.target.commit : item.target?.version),
    links: Array.isArray(item.links) ? item.links.filter((link): link is string => typeof link === "string" && link.startsWith("https://")).slice(0, 10) : [],
    updating: false, lastUpdateError: null,
  };
}

/** Why a finished `--yes` run did not replace the plugin, or null when it reported no failure. */
export function readApplyFailure(result: CommandResult): string | null {
  const entry = readEntry(result.output);
  if (entry?.item?.outcome === "error") return redactUrls(text(entry.item.error) ?? "Paseo reported an error.");
  // The detached update writes stdout and stderr to one log, so a thrown error is in `output`.
  const thrown = readCliError(result.errors ?? "") ?? readCliError(result.output);
  if (thrown) return thrown;
  if (!result.code) return null;
  // Only a plain-text last line with words in it is useful; never a piece of JSON.
  const lastLine = entry ? null : result.output.trim().split(/\r?\n/).filter(Boolean).pop()?.trim();
  return redactUrls(lastLine && /[a-z]/i.test(lastLine) && !/^["{}[\]]/.test(lastLine) ? lastLine.slice(0, 500) : `Paseo's update exited with code ${result.code}.`);
}

/** Checks and applies updates to this plugin with Paseo's own `plugin update` flow. Only Git and npm installs can update. */
export function createPluginUpdater(overrides: Partial<PluginUpdaterIo> = {}) {
  const io = { ...hostIo, ...overrides };
  let starting = false;
  let last: PluginUpdateStatus | null = null;
  let lastUpdateError: string | null = null;

  async function check(): Promise<PluginUpdateStatus> {
    // Paseo is applying the update; don't queue another check behind it.
    if (starting && last) return { ...last, updating: true, lastUpdateError };
    const checkedAt = io.now().toISOString();
    let status: PluginUpdateStatus;
    try { status = readCheckOutput(await io.run(CHECK), checkedAt); }
    catch (error) {
      status = { version: missionControlVersion, source: null, state: "unavailable", current: null, target: null, links: [], checkedAt, error: error instanceof Error ? redactUrls(error.message) : "The Paseo CLI could not be run.", updating: false, lastUpdateError: null };
    }
    last = { ...status, lastUpdateError };
    return last;
  }

  /** Rechecks, requires the target the user reviewed, then starts the update in the background. */
  async function apply(target: string): Promise<{ started: true }> {
    if (starting) throw new Error("An update is already running. Wait for Mission Control to reload.");
    const status = await check();
    if (status.state !== "update") throw new Error(status.state === "current" ? "Mission Control is already up to date." : status.error ?? `No update is available (${status.state}).`);
    if (status.target !== target) throw new Error("A different update appeared since you checked. Review it before updating.");
    starting = true;
    lastUpdateError = null;
    try {
      await io.start(APPLY, result => {
        // Still running, so Paseo did not replace this plugin.
        starting = false;
        lastUpdateError = readApplyFailure(result) ?? "The update finished without reloading Mission Control. Check for updates to see its state.";
      });
    } catch (error) { starting = false; throw error; }
    return { started: true };
  }

  return { check, apply };
}
