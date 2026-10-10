import { ProcessStopped, runProcess } from "./process-tree";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { hideCredentials, hideSecrets } from "../shared/secret-mask";
import {
  applySetupAction,
  planSetupAction,
  readSetup,
  setupLogEntrySchema,
  setupManifest,
  type SetupAction,
  type SetupChange,
  type SetupDependency,
  type SetupFinished,
  type SetupItem,
  type SetupLogEntry,
  type SetupManifest,
  type SetupPlan,
  type SetupReport,
  type SetupResult,
  type SetupStatus,
  type SkillGroup,
  type SkillGroupId,
  type SkillLink,
} from "../shared/setup";
import { defaultVaultPath } from "../shared/vault";
import { daemonServerId } from "./agent-names";
import { projectProfileFile } from "./decisions";
import { azSignIn, bitbucketAuth, credentialFill, findAz, findGh, ghSignIn, parseCredential, type ToolRunner } from "./forge-tools";

// Settings → Setup (task 20). Reading changes nothing and runs only the version commands in the manifest. The three
// installs run only after the user confirms a plan whose fingerprint still matches:
// - skill links: junctions in each provider's skills folder, recorded in MARKER; anything else with that name is left alone;
// - the OCR CLI at its pinned version, through npm's own JavaScript entry point (no npm.cmd, no shell);
// - OCR rule files, written only when missing or still exactly as Mission Control last wrote them (by SHA-256).
// Commands run without a shell, only as .exe files on Windows, with timeouts; output is scrubbed before it is kept.

export const MARKER = ".mission-control-managed.json";
const VERSION_TIMEOUT_MS = 15_000;
// az starts Python and loads its command table, which takes a while on a cold start.
const AZ_TIMEOUT_MS = 45_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
// Well inside Paseo's plugin request timeout; a slower install replies "still running" (see apply).
const REPLY_WITHIN_MS = 20_000;
const LOG_LIMIT = 100;
const LOG_SHOWN = 10;
const OUTPUT_LIMIT = 2000;

export interface CommandOutput { code: number | null; stdout: string; stderr: string }

export interface SetupHost {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  vaultRoot: string;
  /** Where the install log is kept: <PASEO_HOME>/plugin-data/mission-control. */
  dataDir: string;
  now(): Date;
  /** This host's Paseo server ID, from the daemon rather than host.json. */
  serverId(): Promise<string>;
  /** Runs an allowlisted executable without a shell. Rejects only when it could not run or timed out. */
  run(file: string, args: string[], options: { timeoutMs: number; env?: Record<string, string | undefined>; input?: string }): Promise<CommandOutput>;
}

/** Paseo's view of each provider, when the handler has a Paseo client. */
export type ProviderSnapshot = () => Promise<{ entries: { provider: string; status: string; enabled?: boolean }[] }>;

// ---------- small helpers ----------

const sha256 = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

async function pathKind(path: string): Promise<"missing" | "link" | "directory" | "file" | "other"> {
  try {
    const info = await lstat(path);
    return info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
  } catch { return "missing"; }
}
const isFile = async (path: string) => { try { return (await stat(path)).isFile(); } catch { return false; } };
const isDirectory = async (path: string) => { try { return (await stat(path)).isDirectory(); } catch { return false; } };
async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")); } catch { return null; }
}
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

/** Comparable form of a path: no \\?\ prefix, resolved, and case-folded on Windows. */
function comparablePath(path: string, platform: NodeJS.Platform) {
  const resolved = resolve(path.replace(/^\\\\\?\\/, "")).replace(/[\\/]+$/, "");
  return platform === "win32" ? resolved.replaceAll("/", "\\").toLowerCase() : resolved;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform) {
  return comparablePath(a, platform) === comparablePath(b, platform);
}

function insidePath(parent: string, child: string, platform: NodeJS.Platform) {
  const separator = platform === "win32" ? "\\" : "/";
  return comparablePath(child, platform).startsWith(`${comparablePath(parent, platform)}${separator}`);
}

async function atomicWrite(file: string, content: Buffer | string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

// ---------- stable kit ----------

// Paseo installs a Git plugin into <PASEO_HOME>/plugins/<id>/<install>/checkout and replaces that folder on every
// update, which broke kitRoot, every skill link and running agents' paths. Mission Control keeps a link at
// <PASEO_HOME>/plugin-data/mission-control/kit pointed at the current install instead.
const managedInstalls = (host: Pick<SetupHost, "dataDir">) => resolve(host.dataDir, "..", "..", "plugins", "mission-control");
export const stableKitPath = (host: Pick<SetupHost, "dataDir">) => join(host.dataDir, "kit");

type StableKit = { path: string; target: string | null; status: SetupStatus; detail: string };

async function currentManagedKit(host: Pick<SetupHost, "dataDir">): Promise<string | null> {
  const root = managedInstalls(host);
  const found: { path: string; at: number }[] = [];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const checkout = join(root, name, "checkout");
    if (await isFile(join(checkout, "scripts", "dev-flow.mjs")) && await isDirectory(join(checkout, "skills"))) {
      found.push({ path: checkout, at: (await stat(checkout)).mtimeMs });
    }
  }
  // Mid-update both installs can exist briefly; the newer one is the update.
  return found.sort((a, b) => b.at - a.at)[0]?.path ?? null;
}

let stableKitQueue: Promise<unknown> = Promise.resolve();

/** Points the stable kit link at the current managed install. Never removes anything but a link, and one change at a time. */
export function ensureStableKit(host: Pick<SetupHost, "dataDir" | "platform">): Promise<StableKit> {
  const next = stableKitQueue.then(async (): Promise<StableKit> => {
    const path = stableKitPath(host);
    const target = await currentManagedKit(host);
    if (!target) return { path, target, status: "unknown", detail: "No Paseo-managed install of Mission Control was found. A directory install doesn't move, so it doesn't need this." };
    const kind = await pathKind(path);
    if (kind !== "missing" && kind !== "link") return { path, target, status: "modified", detail: `${path} isn't a link Mission Control made, so it's left alone.` };
    if (kind === "link" && samePath(await readlink(path), target, host.platform)) return { path, target, status: "installed", detail: `Points at the current install, ${target}.` };
    await mkdir(dirname(path), { recursive: true });
    if (kind === "link") await unlink(path);
    await symlink(target, path, "junction");
    return { path, target, status: "installed", detail: `Now points at the current install, ${target}.` };
  });
  stableKitQueue = next.catch(() => undefined);
  return next;
}

/** The first x.y or x.y.z in a command's output or a package version. */
export function parseVersion(output: string): string | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3] ?? "0"}` : null;
}

/** Negative when a < b. Pre-release and build suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => (parseVersion(value) ?? "0.0.0").split(".").map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] - y[index];
  return 0;
}

/** Keeps the end of a command's output, with key-like strings hidden. Hidden first, so a key cut in half can't lose its prefix and slip through. */
export function scrubOutput(output: string): string | null {
  const hidden = hideSecrets(output.replace(/\u001b\[[0-9;]*m/g, "").trim());
  if (!hidden) return null;
  return hidden.length > OUTPUT_LIMIT ? `…${hidden.slice(-OUTPUT_LIMIT)}` : hidden;
}

// ---------- running commands ----------

/** Only real executables run: never a .cmd, .bat or .ps1 launcher, which would need a shell on Windows. */
export function assertRunnable(file: string, platform: NodeJS.Platform) {
  if (!isAbsolute(file)) throw new Error("Mission Control runs commands only by their full path.");
  if (platform === "win32" ? !/\.exe$/i.test(file) : /\.(cmd|bat|ps1|sh)$/i.test(file)) throw new Error(`${basename(file)} isn't an executable Mission Control runs; it would need a shell.`);
}

export function runExecutable(file: string, args: string[], options: { timeoutMs: number; env?: Record<string, string | undefined>; input?: string }, platform = process.platform): Promise<CommandOutput> {
  assertRunnable(file, platform);
  // At the time limit the whole process tree ends, npm's own child processes included.
  return runProcess(file, args, { timeoutMs: options.timeoutMs, maxBuffer: 4 * 1024 * 1024, env: options.env, input: options.input }).catch(error => {
    if (error instanceof ProcessStopped) throw new Error(`${basename(file)} didn't finish within ${Math.round(options.timeoutMs / 1000)} seconds.`);
    // Node's own message repeats the command line; report only what failed.
    const code = (error as { code?: unknown }).code;
    throw new Error(`${basename(file)} couldn't be run${typeof code === "string" ? ` (${code})` : ""}.`);
  });
}

function pathDirs(env: Record<string, string | undefined>) {
  const key = Object.keys(env).find(name => name.toLowerCase() === "path");
  return (key ? env[key] ?? "" : "").split(delimiter).map(entry => entry.trim().replace(/^"(.*)"$/, "$1")).filter(entry => isAbsolute(entry));
}

/** The executable a command name runs: `<name>.exe` on Windows, `<name>` elsewhere, from PATH then the manifest's extra folders. */
export async function findExecutable(host: Pick<SetupHost, "env" | "platform">, name: string, extraDirs: { env: string; path: string }[] = []): Promise<string | null> {
  const file = host.platform === "win32" ? `${name}.exe` : name;
  const extra = extraDirs.flatMap(dir => host.env[dir.env] && isAbsolute(host.env[dir.env]!) ? [join(host.env[dir.env]!, dir.path)] : []);
  for (const dir of [...pathDirs(host.env), ...extra]) {
    const candidate = join(dir, file);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

// ---------- npm, Paseo and Obsidian locations ----------

/** npm's global prefix: npm_config_prefix, then `prefix=` in ~/.npmrc, then npm's default. */
export async function npmPrefix(host: Pick<SetupHost, "env" | "home" | "platform">, nodeExe: string | null): Promise<string | null> {
  const fromEnv = text(Object.entries(host.env).find(([key]) => key.toLowerCase() === "npm_config_prefix")?.[1]);
  if (fromEnv) return fromEnv;
  try {
    const line = (await readFile(join(host.home, ".npmrc"), "utf8")).split(/\r?\n/).find(entry => /^\s*prefix\s*=/.test(entry));
    const value = line ? text(line.slice(line.indexOf("=") + 1).replace(/^["']|["']$/g, "")) : null;
    if (value) return value.startsWith("~") ? join(host.home, value.slice(1)) : value;
  } catch { /* No ~/.npmrc. */ }
  if (host.platform === "win32") return host.env.APPDATA ? join(host.env.APPDATA, "npm") : null;
  return nodeExe ? dirname(dirname(nodeExe)) : null;
}

const globalModules = (prefix: string, platform: NodeJS.Platform) => platform === "win32" ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules");

/** npm's own entry point beside Node, so installs run as `node npm-cli.js …` without npm.cmd. */
function npmCli(nodeExe: string, platform: NodeJS.Platform) {
  const root = platform === "win32" ? join(dirname(nodeExe), "node_modules", "npm") : join(dirname(dirname(nodeExe)), "lib", "node_modules", "npm");
  return { packageJson: join(root, "package.json"), cli: join(root, "bin", "npm-cli.js") };
}

async function packageVersion(file: string): Promise<string | null> {
  const value = record(await readJson(file));
  return text(value?.version);
}

/** The newest `x.y.z` folder in a tool's own download folder, such as Copilot's %LOCALAPPDATA%\copilot\pkg\win32-x64. */
async function newestVersionFolder(host: Pick<SetupHost, "env">, dir: { env: string; path: string }): Promise<{ version: string; path: string } | null> {
  const base = host.env[dir.env];
  if (!base || !isAbsolute(base)) return null;
  const folder = join(base, ...dir.path.split("/"));
  const versions = (await readdir(folder, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name)).map(entry => entry.name);
  const newest = versions.sort(compareVersions).pop();
  return newest ? { version: newest, path: join(folder, newest) } : null;
}

function paseoLocations(host: Pick<SetupHost, "env" | "platform">) {
  if (host.platform !== "win32" || !host.env.LOCALAPPDATA) return null;
  const app = join(host.env.LOCALAPPDATA, "Programs", "Paseo");
  const resources = join(app, "resources");
  return {
    exe: join(app, "Paseo.exe"),
    // What paseo.cmd runs, without cmd.exe: the bundled app as Node, on the CLI inside app.asar.
    args: ["--disable-warning=DEP0040", join(resources, "app.asar.unpacked", "dist", "daemon", "node-entrypoint-runner.js"), "node-script", join(resources, "app.asar", "node_modules", "@getpaseo", "cli", "dist", "index.js"), "--version"],
  };
}

function obsidianLocations(host: Pick<SetupHost, "env" | "platform" | "home">) {
  const config = host.platform === "win32" ? join(host.env.APPDATA ?? join(host.home, "AppData", "Roaming"), "obsidian")
    : host.platform === "darwin" ? join(host.home, "Library", "Application Support", "obsidian")
      : join(host.env.XDG_CONFIG_HOME ?? join(host.home, ".config"), "obsidian");
  const app = host.platform === "win32" && host.env.LOCALAPPDATA ? join(host.env.LOCALAPPDATA, "Programs", "Obsidian") : null;
  return { configDir: config, configFile: join(config, "obsidian.json"), exe: app && join(app, "Obsidian.exe"), cli: app && join(app, "Obsidian.com") };
}

// ---------- dependencies ----------

function expectedLabel(dependency: SetupDependency) {
  return dependency.pinned ? `pinned ${dependency.pinned}` : dependency.minimum ? `≥ ${dependency.minimum}` : null;
}

function item(dependency: SetupDependency, status: SetupStatus, version: string | null, detail: string): SetupItem {
  return {
    id: dependency.id, name: dependency.name, status, version, expected: expectedLabel(dependency), detail: hideSecrets(detail),
    help: dependency.help, optional: dependency.optional, installable: dependency.install === "mission-control",
  };
}

/** Installed, or Outdated against the pinned or minimum version. A pinned version must match exactly. */
function versionStatus(dependency: SetupDependency, version: string | null): SetupStatus {
  if (!version) return "installed";
  if (dependency.pinned) return compareVersions(version, dependency.pinned) === 0 ? "installed" : "outdated";
  if (dependency.minimum && compareVersions(version, dependency.minimum) < 0) return "outdated";
  return "installed";
}

async function versionCommand(host: SetupHost, dependency: SetupDependency, file: string, args: string[], env?: Record<string, string | undefined>): Promise<SetupItem> {
  try {
    const result = await host.run(file, args, { timeoutMs: VERSION_TIMEOUT_MS, env });
    const output = `${result.stdout}\n${result.stderr}`;
    const version = parseVersion(result.stdout) ?? parseVersion(result.stderr);
    if (result.code !== 0 || !version) return item(dependency, "unknown", null, `${file} answered without a version${result.code ? ` (exit code ${result.code})` : ""}. ${scrubOutput(output)?.split(/\r?\n/)[0] ?? ""}`.trim());
    return item(dependency, versionStatus(dependency, version), version, file);
  } catch (error) {
    return item(dependency, "unknown", null, errorMessage(error));
  }
}

/** The forge tools' sign-in checks, run through the host's runner (full-path executables, no shell, time limits). */
function hostRunner(host: SetupHost): ToolRunner {
  return async (command, args, options = {}) => {
    const result = await host.run(command.file, [...command.prefix, ...args], { timeoutMs: options.timeoutMs ?? VERSION_TIMEOUT_MS, env: { ...host.env, ...command.env } });
    return { code: result.code ?? -1, stdout: result.stdout, stderr: result.stderr };
  };
}

interface DetectContext { host: SetupHost; manifest: SetupManifest; nodeExe: string | null; prefix: string | null; providers: Map<string, string> | null; ocrRules: SetupReport["ocrRules"]; githubHosts: string[]; azureOrganizations: string[] }

/** The forges this host's projects use (Settings → Delivery's detection, custom hosts and overrides), and their GitHub hosts. */
export type ForgesInUse = () => Promise<{ forges: Set<"github" | "azure-devops" | "bitbucket">; githubHosts: string[]; azureOrganizations?: string[] } | null>;
// The forge tools' rows, and the forge each is for.
const forgeTools: Record<string, { forge: "github" | "azure-devops" | "bitbucket"; label: string }> = {
  gh: { forge: "github", label: "GitHub" }, az: { forge: "azure-devops", label: "Azure DevOps" }, bitbucket: { forge: "bitbucket", label: "Bitbucket Cloud" },
};

async function detect(context: DetectContext, dependency: SetupDependency): Promise<SetupItem> {
  const { host } = context;
  const detectSpec = dependency.detect;
  switch (detectSpec.kind) {
    case "paseo": {
      const paseo = paseoLocations(host);
      if (paseo && await isFile(paseo.exe)) return versionCommand(host, dependency, paseo.exe, paseo.args, { ...host.env, ELECTRON_RUN_AS_NODE: "1" });
      const cli = await findExecutable(host, "paseo");
      if (cli) return versionCommand(host, dependency, cli, ["--version"]);
      return item(dependency, "unknown", null, "Paseo's app or CLI wasn't found in its usual place, so its version is unknown.");
    }
    case "command": {
      const file = detectSpec.command === "node" && context.nodeExe ? context.nodeExe : await findExecutable(host, detectSpec.command, detectSpec.extraDirs);
      if (!file) return item(dependency, "missing", null, `${detectSpec.command} wasn't found on this host's PATH.`);
      return versionCommand(host, dependency, file, detectSpec.args);
    }
    case "npm-self": {
      if (!context.nodeExe) return item(dependency, "missing", null, "Node.js wasn't found, so npm wasn't either.");
      const { packageJson } = npmCli(context.nodeExe, host.platform);
      const version = await packageVersion(packageJson);
      return version ? item(dependency, versionStatus(dependency, version), version, dirname(packageJson)) : item(dependency, "missing", null, `No npm beside Node at ${dirname(packageJson)}.`);
    }
    case "npm-package": {
      const paseoStatus = detectSpec.provider && context.providers ? context.providers.get(detectSpec.provider) ?? "not listed" : null;
      const suffix = paseoStatus ? ` · Paseo: ${paseoStatus}` : "";
      if (!context.prefix) return item(dependency, "unknown", null, `npm's global folder couldn't be found.${suffix}`);
      const folder = join(globalModules(context.prefix, host.platform), ...detectSpec.package.split("/"));
      const version = await packageVersion(join(folder, "package.json"));
      const selfUpdated = detectSpec.selfUpdateDir ? await newestVersionFolder(host, detectSpec.selfUpdateDir) : null;
      if (selfUpdated && (!version || compareVersions(selfUpdated.version, version) > 0)) {
        return item(dependency, versionStatus(dependency, selfUpdated.version), selfUpdated.version, `Updated itself: ${selfUpdated.path}${version ? ` (npm package ${version})` : ""}${suffix}`);
      }
      if (!version) return item(dependency, "missing", null, `Not in npm's global packages (${globalModules(context.prefix, host.platform)}).${suffix}`);
      return item(dependency, versionStatus(dependency, version), version, `${folder}${suffix}`);
    }
    case "ocr-rules": {
      const files = context.ocrRules.files;
      const order: SetupStatus[] = ["unknown", "missing", "outdated", "modified", "not-managed"];
      const status = order.find(state => files.some(file => file.status === state)) ?? "installed";
      const counts = order.concat("installed").map(state => [state, files.filter(file => file.status === state).length] as const).filter(([, count]) => count > 0);
      return item(dependency, status, null, `${context.ocrRules.folder} · ${counts.map(([state, count]) => `${count} ${state.replace("-", " ")}`).join(", ")}`);
    }
    case "obsidian-app": {
      const places = obsidianLocations(host);
      const asars = (await readdir(places.configDir).catch(() => [] as string[])).map(name => /^obsidian-(\d+\.\d+\.\d+)\.asar$/.exec(name)?.[1]).filter((value): value is string => !!value);
      const version = asars.sort(compareVersions).pop() ?? null;
      const exe = places.exe ? await isFile(places.exe) : false;
      if (!exe && !version && !await isFile(places.configFile)) return item(dependency, "missing", null, "Obsidian wasn't found.");
      const config = record(await readJson(places.configFile));
      const vaults = Object.values(record(config?.vaults) ?? {}).map(entry => text(record(entry)?.path)).filter((path): path is string => !!path);
      const registered = vaults.some(path => samePath(path, host.vaultRoot, host.platform));
      return item(dependency, "installed", version, [exe ? places.exe : "App files found", registered ? `${host.vaultRoot} is registered` : `${host.vaultRoot} isn't registered as a vault`].join(" · "));
    }
    case "gh": {
      const gh = await findGh(host.env, host.platform);
      if (!gh) return item(dependency, "missing", null, "gh wasn't found on this host's PATH.");
      const found = await versionCommand(host, dependency, gh.file, ["--version"], { ...host.env, ...gh.env });
      if (found.status === "unknown") return found;
      // Each GitHub host the projects use: github.com, or GitHub Enterprise hosts from Settings → Delivery.
      const hosts = context.githubHosts.length ? context.githubHosts : ["github.com"];
      const answers = await Promise.all(hosts.map(name => ghSignIn(gh, hostRunner(host), name).catch(error => ({ signedIn: false, detail: `The sign-in to ${name} couldn't be checked: ${errorMessage(error)}` }))));
      return { ...found, signIn: { signedIn: answers.every(answer => answer.signedIn), detail: hideCredentials(answers.map(answer => answer.detail).join(" ")) } };
    }
    case "az": {
      const az = await findAz(host.env, host.platform);
      if (!az) return item(dependency, "missing", null, "az (Azure CLI) wasn't found on this host's PATH.");
      let version: string | null = null;
      try {
        const result = await host.run(az.file, [...az.prefix, "version", "--output", "json"], { timeoutMs: AZ_TIMEOUT_MS, env: { ...host.env, ...az.env } });
        if (result.code === 0) { try { version = text(record(JSON.parse(result.stdout))?.["azure-cli"]) ?? parseVersion(result.stdout); } catch { version = parseVersion(result.stdout); } }
      } catch (error) { return item(dependency, "unknown", null, errorMessage(error)); }
      // Each Azure DevOps organization the projects use, Servers included (az devops login counts there).
      const signIn = await azSignIn(az, host.env, hostRunner(host), context.azureOrganizations).catch(error => ({ signedIn: false, detail: `The sign-in couldn't be checked: ${errorMessage(error)}` }));
      return { ...item(dependency, version ? versionStatus(dependency, version) : "unknown", version, az.file), signIn: { signedIn: signIn.signedIn, detail: hideCredentials(signIn.detail) } };
    }
    case "bitbucket-credentials": {
      const git = await findExecutable(host, "git");
      // Only whether credentials exist is kept; the user name and password never leave this function.
      const stored = async (hostname: string, env: Record<string, string | undefined>) => {
        if (!git) return null;
        const fill = credentialFill(hostname, env);
        return parseCredential(await host.run(git, fill.args, { timeoutMs: VERSION_TIMEOUT_MS, env: fill.env, input: fill.input }).catch(() => ({ code: null, stdout: "" })));
      };
      const auth = await bitbucketAuth(host.env, stored);
      return auth ? item(dependency, "installed", null, `Found in ${auth.source}. Open PR uses them for Bitbucket Cloud; they're never stored or shown.`)
        : item(dependency, "missing", null, "No BITBUCKET_TOKEN, no BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD, and no bitbucket.org credential in Git's credential store.");
    }
    case "obsidian-cli": {
      const places = obsidianLocations(host);
      const config = record(await readJson(places.configFile));
      const launcher = places.cli ? await isFile(places.cli) : false;
      if (config?.cli === true && launcher) return item(dependency, "installed", null, `Turned on · ${places.cli}`);
      if (config?.cli === true) return item(dependency, "unknown", null, "Turned on in obsidian.json, but Obsidian.com wasn't found.");
      return item(dependency, "missing", null, config ? "Not turned on in Obsidian." : "Obsidian's settings weren't found.");
    }
  }
}

// ---------- vault and kit ----------

function frontMatter(markdown: string): Record<string, unknown> | null {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return null;
  const fields: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at < 1) continue;
    try { fields[line.slice(0, at).trim()] = JSON.parse(line.slice(at + 1).trim()); } catch { fields[line.slice(0, at).trim()] = line.slice(at + 1).trim(); }
  }
  return fields;
}

async function readVaultAndKit(host: SetupHost, manifest: SetupManifest, stable?: StableKit): Promise<Pick<SetupReport, "vault" | "kit">> {
  const root = host.vaultRoot;
  const exists = await isDirectory(root);
  let hostJson: SetupReport["vault"]["hostJson"];
  if (!exists) hostJson = { status: "missing", detail: "The vault folder doesn't exist." };
  else {
    const saved = record(await readJson(join(root, "host.json")));
    const savedId = text(saved?.serverId);
    if (!saved) hostJson = { status: "missing", detail: "host.json is missing or unreadable." };
    else if (!savedId) hostJson = { status: "unknown", detail: "host.json has no serverId." };
    else {
      try {
        const actual = await host.serverId();
        hostJson = actual === savedId
          ? { status: "installed", detail: `Matches this host (${savedId}${text(saved.hostId) ? `, host ${text(saved.hostId)}` : ""}).` }
          : { status: "modified", detail: `host.json names ${savedId}, but this host is ${actual}. Tasks and decisions here won't match this host until it's corrected.` };
      } catch (error) {
        hostJson = { status: "unknown", detail: `host.json names ${savedId}; this host's server ID couldn't be read: ${errorMessage(error)}` };
      }
    }
  }
  const profiles: SetupReport["kit"]["profiles"] = [];
  const profilesToMove: string[] = [];
  const projects = join(root, "Projects");
  for (const name of (await readdir(projects).catch(() => [] as string[])).filter(entry => entry.endsWith(".md")).sort()) {
    const fields = await readFile(join(projects, name), "utf8").then(frontMatter, () => null);
    if (!fields || !("projectId" in fields)) continue;
    const kitRoot = text(fields.kitRoot);
    const base = { file: join(projects, name), projectId: text(fields.projectId), kitRoot, developerCheckout: false };
    // Naming one managed install's folder breaks on the next update; the stable link doesn't.
    const oneInstall = !!kitRoot && projectProfileFile.test(name) && insidePath(managedInstalls(host), kitRoot, host.platform);
    if (oneInstall) profilesToMove.push(base.file);
    if (oneInstall && !await isDirectory(kitRoot)) {
      profiles.push({ ...base, status: "missing", detail: "An update replaced this install. Use the stable kit path for this profile." });
      continue;
    }
    // Launch and the Morning check skip other names, so the profile would look installed but never be used.
    if (!projectProfileFile.test(name)) {
      profiles.push({ ...base, status: "modified", detail: "Mission Control ignores this profile: rename it using only lowercase letters, digits, hyphens and underscores, such as my-project.md." });
      continue;
    }
    if (!kitRoot || !isAbsolute(kitRoot)) { profiles.push({ ...base, status: "unknown", detail: "The profile has no absolute kitRoot." }); continue; }
    if (!await isDirectory(kitRoot)) { profiles.push({ ...base, status: "missing", detail: "kitRoot doesn't exist." }); continue; }
    const complete = await isDirectory(join(kitRoot, manifest.skills.kitFolder)) && await isFile(join(kitRoot, "scripts", "dev-flow.mjs"));
    const developerCheckout = (await pathKind(join(kitRoot, ".git"))) !== "missing";
    if (!complete) { profiles.push({ ...base, developerCheckout, status: "unknown", detail: "kitRoot has no skills folder or scripts/dev-flow.mjs." }); continue; }
    profiles.push({ ...base, developerCheckout, status: "installed", detail: developerCheckout ? "Developer checkout (Git). Update it with Git; Mission Control doesn't install the kit here." : "Kit folder." });
  }
  const usable = profiles.filter(profile => profile.status === "installed").map(profile => profile.kitRoot!);
  const distinct = usable.filter((path, index) => usable.findIndex(other => samePath(other, path, host.platform)) === index);
  const kitRoot = distinct.length === 1 ? distinct[0] : null;
  const rootNote = !exists ? "No vault, so no project profile names a kit."
    : distinct.length > 1 ? `Project profiles name different kits (${distinct.join(", ")}), so skill links and rule files aren't offered.`
      : !kitRoot ? "No project profile names a usable kitRoot." : null;
  return { vault: { root, exists, hostJson }, kit: { profiles, root: kitRoot, rootNote, ...(stable ? { stable: { ...stable, profilesToMove } } : {}) } };
}

// ---------- skill links ----------

type Marker = { links: Record<string, { target: string; linkedAt: string }> };

async function readMarker(folder: string): Promise<Marker> {
  const links = record(record(await readJson(join(folder, MARKER)))?.links) ?? {};
  const result: Marker = { links: {} };
  for (const [name, value] of Object.entries(links)) {
    const target = text(record(value)?.target);
    if (target) result.links[name] = { target, linkedAt: text(record(value)?.linkedAt) ?? "" };
  }
  return result;
}

async function kitSkills(kitRoot: string, manifest: SetupManifest) {
  const folder = join(kitRoot, manifest.skills.kitFolder);
  const names: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && await isFile(join(folder, entry.name, "SKILL.md"))) names.push(entry.name);
  }
  return names.sort().map(name => ({ name, target: join(folder, name) }));
}

/** The folders a group links to; each holds a SKILL.md. An older kit may not have the delegate skill yet. */
async function groupTargets(kitRoot: string, manifest: SetupManifest, group: SkillGroupId) {
  if (group === "development-flow") return kitSkills(kitRoot, manifest);
  const target = join(kitRoot, manifest.skills.delegate.source);
  return await isFile(join(target, "SKILL.md")) ? [{ name: manifest.skills.delegate.name, target }] : [];
}

async function linkStatus(host: SetupHost, folder: string, marker: Marker, name: string, target: string): Promise<SkillLink & { current: string | null }> {
  const path = join(folder, name);
  const kind = await pathKind(path);
  const owned = marker.links[name];
  if (kind === "missing") return { name, path, target, status: "missing", note: null, current: null };
  if (kind === "link") {
    const current = await readlink(path).catch(() => "");
    if (samePath(current, target, host.platform)) return { name, path, target, status: "installed", note: owned ? null : "Linked outside Mission Control; left as it is.", current };
    if (owned && samePath(current, owned.target, host.platform)) return { name, path, target, status: "outdated", note: `Mission Control's link points at ${current}. Update re-points it.`, current };
    if (owned) return { name, path, target, status: "modified", note: `Mission Control linked this to ${owned.target}, but it now points at ${current || "an unreadable target"}; left alone.`, current };
    return { name, path, target, status: "not-managed", note: `A link to ${current || "an unreadable target"} that Mission Control didn't make; left alone.`, current };
  }
  if (owned) return { name, path, target, status: "modified", note: "Mission Control linked this, but it has since been replaced; left alone.", current: null };
  return { name, path, target, status: "not-managed", note: `A ${kind === "directory" ? "folder" : "file"} Mission Control didn't create; left alone.`, current: null };
}

function overallStatus(statuses: SetupStatus[]): SetupStatus {
  if (!statuses.length) return "unknown";
  for (const state of ["unknown", "missing", "outdated", "modified", "not-managed"] as const) if (statuses.includes(state)) return state;
  return "installed";
}

async function skillGroup(host: SetupHost, manifest: SetupManifest, kitRoot: string | null, kitNote: string | null, provider: SetupManifest["skills"]["providers"][number], group: SkillGroupId) {
  const folder = join(host.home, ...provider.folder.split("/"));
  const folderExists = await isDirectory(folder);
  const base = { provider: provider.id, providerName: provider.name, group, folder, folderExists };
  if (!kitRoot) return { group: { ...base, status: "unknown" as const, links: [], blocked: kitNote ?? "No kit to link to." }, current: [] };
  const targets = await groupTargets(kitRoot, manifest, group);
  if (!targets.length) {
    const missing = group === "development-flow" ? `No skills found in ${join(kitRoot, manifest.skills.kitFolder)}.` : `The kit has no ${join(kitRoot, manifest.skills.delegate.source, "SKILL.md")} yet. Update the kit, then check again.`;
    return { group: { ...base, status: "unknown" as const, links: [], blocked: missing }, current: [] };
  }
  if (!folderExists) {
    const links = targets.map(({ name, target }) => ({ name, path: join(folder, name), target, status: "missing" as const, note: null }));
    return { group: { ...base, status: "missing" as const, links, blocked: `${folder} doesn't exist. Start ${provider.name} once, or create the folder, then check again.` }, current: [] };
  }
  const marker = await readMarker(folder);
  const detailed = await Promise.all(targets.map(({ name, target }) => linkStatus(host, folder, marker, name, target)));
  const links: SkillLink[] = detailed.map(({ current: _current, ...link }) => link);
  const blocked = links.some(link => link.status === "missing" || link.status === "outdated") ? null : "Nothing to install.";
  return { group: { ...base, status: overallStatus(links.map(link => link.status)), links, blocked } satisfies SkillGroup, current: detailed.map(link => link.current) };
}

// ---------- OCR rule files ----------

type OcrMarker = { files: Record<string, { sha256: string; writtenAt: string }> };

async function readOcrMarker(folder: string): Promise<OcrMarker> {
  const files = record(record(await readJson(join(folder, MARKER)))?.files) ?? {};
  const result: OcrMarker = { files: {} };
  for (const [path, value] of Object.entries(files)) {
    const hash = text(record(value)?.sha256);
    if (hash) result.files[path] = { sha256: hash, writtenAt: text(record(value)?.writtenAt) ?? "" };
  }
  return result;
}

async function fileHash(path: string): Promise<string | null> {
  try { return sha256(await readFile(path)); } catch { return null; }
}

type RuleState = { path: string; source: string; destination: string; status: SetupStatus; note: string | null; current: string | null; kit: string | null };

async function ocrRuleStates(host: SetupHost, manifest: SetupManifest, kitRoot: string | null): Promise<{ folder: string; files: RuleState[] }> {
  const folder = join(host.home, manifest.ocr.home);
  const marker = await readOcrMarker(folder);
  const files: RuleState[] = [];
  for (const file of manifest.ocr.files) {
    const destination = join(folder, ...file.path.split("/"));
    const source = kitRoot ? join(kitRoot, ...file.source.split("/")) : file.source;
    const kit = kitRoot ? await fileHash(source) : null;
    const kind = await pathKind(destination);
    const current = kind === "file" ? await fileHash(destination) : null;
    const owned = marker.files[file.path];
    const base = { path: file.path, source, destination, current, kit };
    if (!kit) files.push({ ...base, status: "unknown", note: kitRoot ? `The kit's copy (${source}) is missing.` : "No kit to copy from." });
    else if (kind === "missing") files.push({ ...base, status: "missing", note: null });
    else if (kind !== "file") files.push({ ...base, status: "not-managed", note: "Not a regular file; left alone." });
    else if (current === kit) files.push({ ...base, status: "installed", note: owned ? null : "Same as the kit's copy, but not written by Mission Control." });
    else if (owned && current === owned.sha256) files.push({ ...base, status: "outdated", note: "Unchanged since Mission Control wrote it, and the kit's copy is newer. Update replaces it." });
    else if (owned) files.push({ ...base, status: "modified", note: "Edited since Mission Control wrote it; left alone." });
    else files.push({ ...base, status: "not-managed", note: file.path === "rule.json"
      ? "An existing rule.json Mission Control didn't write. It's never merged automatically; add the C# entry by hand (docs/ocr-kit/windows-setup.md, section 3)."
      : "A file Mission Control didn't write; left alone." });
  }
  return { folder, files };
}

// ---------- log ----------

const logFile = (host: SetupHost) => join(host.dataDir, "setup-log.jsonl");

async function readLog(host: SetupHost): Promise<SetupLogEntry[]> {
  const lines = (await readFile(logFile(host), "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean);
  const entries: SetupLogEntry[] = [];
  for (const line of lines) {
    // A torn or foreign line is skipped rather than failing the whole screen.
    try { const entry = setupLogEntrySchema.safeParse(JSON.parse(line)); if (entry.success) entries.push(entry.data); } catch { /* Not JSON. */ }
  }
  return entries;
}

async function appendLog(host: SetupHost, entry: SetupLogEntry) {
  await mkdir(host.dataDir, { recursive: true });
  const entries = [...await readLog(host), entry].slice(-LOG_LIMIT);
  await atomicWrite(logFile(host), `${entries.map(value => JSON.stringify(value)).join("\n")}\n`);
}

// ---------- the service ----------

export function createSetupService(host: SetupHost, manifest: SetupManifest = setupManifest, options: { replyWithinMs: number } = { replyWithinMs: REPLY_WITHIN_MS }) {
  let running: SetupReport["running"] = null;
  let lastResult: SetupFinished | null = null;

  async function state(providerSnapshot?: ProviderSnapshot) {
    const stable = await ensureStableKit(host).catch((error): StableKit => ({ path: stableKitPath(host), target: null, status: "unknown", detail: `The stable kit link couldn't be checked: ${errorMessage(error)}` }));
    const { vault, kit } = await readVaultAndKit(host, manifest, stable);
    const skills = await Promise.all(manifest.skills.providers.flatMap(provider => (["development-flow", "ocr-delegate"] as const).map(group => skillGroup(host, manifest, kit.root, kit.rootNote, provider, group))));
    const rules = await ocrRuleStates(host, manifest, kit.root);
    const nodeExe = await findExecutable(host, "node");
    const prefix = await npmPrefix(host, nodeExe);
    let providers: Map<string, string> | null = null;
    if (providerSnapshot) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const snapshot = await Promise.race([providerSnapshot(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 5000); })]);
        providers = new Map(snapshot.entries.map(entry => [entry.provider, entry.enabled === false ? "turned off" : entry.status]));
      } catch { providers = null; } finally { clearTimeout(timer); }
    }
    return { vault, kit, skills, rules, nodeExe, prefix, providers };
  }

  async function read(providerSnapshot?: ProviderSnapshot, forgesInUse?: ForgesInUse): Promise<SetupReport> {
    const current = await state(providerSnapshot);
    const ocrRules = { folder: current.rules.folder, files: current.rules.files.map(({ path, source, status, note }) => ({ path, source, status, note })) };
    // Forge tools only for forges this host's projects use; all of them when that can't be read.
    const inUse = forgesInUse ? await forgesInUse().catch(() => null) : null;
    const shown = manifest.dependencies.filter(dependency => !inUse || !forgeTools[dependency.id] || inUse.forges.has(forgeTools[dependency.id].forge));
    const hiddenTools = manifest.dependencies.filter(dependency => !shown.includes(dependency))
      .map(dependency => ({ id: dependency.id, name: dependency.name, reason: `No project on this host uses ${forgeTools[dependency.id].label}.` }));
    const context: DetectContext = { host, manifest, nodeExe: current.nodeExe, prefix: current.prefix, providers: current.providers, ocrRules, githubHosts: inUse?.githubHosts ?? [], azureOrganizations: inUse?.azureOrganizations ?? [] };
    const items = await Promise.all(shown.map(dependency => detect(context, dependency)));
    const bySection = (section: SetupDependency["section"]) => items.filter((_, index) => shown[index].section === section);
    return {
      checkedAt: host.now().toISOString(), home: host.home,
      paseo: bySection("paseo")[0] ?? { id: "paseo", name: "Paseo", status: "unknown", version: null, expected: null, detail: "Not in the manifest.", help: { text: "", command: null, link: null }, optional: false, installable: false },
      vault: current.vault, kit: current.kit,
      skills: current.skills.map(entry => entry.group),
      tools: bySection("tools"), ocrRules, providers: bySection("providers"),
      log: (await readLog(host)).slice(-LOG_SHOWN).reverse(),
      running, lastResult, hiddenTools,
    };
  }

  /** The plan for one action plus the private details apply needs. The fingerprint covers everything apply relies on. */
  async function prepare(action: SetupAction) {
    const current = await state();
    const finish = (plan: Omit<SetupPlan, "fingerprint">, basis: unknown) => ({ plan: { ...plan, fingerprint: sha256(JSON.stringify({ plan, basis })) } as SetupPlan, current });
    if (action.kind === "skills") {
      const provider = manifest.skills.providers.find(entry => entry.id === action.provider);
      const index = current.skills.findIndex(entry => entry.group.provider === action.provider && entry.group.group === action.group);
      if (!provider || index < 0) return finish({ action, title: "Unknown provider", command: null, changes: [], blocked: "That provider isn't in Mission Control's manifest." }, null);
      const { group, current: targets } = current.skills[index];
      const what = action.group === "development-flow" ? "Development Flow skills" : `the ${manifest.skills.delegate.name} skill (${manifest.skills.delegate.version})`;
      const changes: SetupChange[] = group.links.map(link => link.status === "missing" ? { path: link.path, change: "create-link", detail: `Junction → ${link.target}` }
        : link.status === "outdated" ? { path: link.path, change: "replace-link", detail: `Re-point Mission Control's junction → ${link.target}` }
          : { path: link.path, change: "skip", detail: link.status === "installed" ? "Already linked." : link.note ?? "Left alone." });
      return finish({ action, title: `Link ${what} for ${provider.name}`, command: null, changes, blocked: group.blocked }, { links: group.links, targets, marker: await readFile(join(group.folder, MARKER), "utf8").catch(() => null) });
    }
    if (action.kind === "ocr-rules") {
      const changes: SetupChange[] = current.rules.files.map(file => file.status === "missing" ? { path: file.destination, change: "write-file", detail: `Copy from ${file.source}` }
        : file.status === "outdated" ? { path: file.destination, change: "update-file", detail: `Replace with ${file.source}` }
          : { path: file.destination, change: "skip", detail: file.status === "installed" ? "Already the kit's copy." : file.note ?? "Left alone." });
      const blocked = !current.kit.root ? current.kit.rootNote ?? "No kit to copy from." : changes.some(change => change.change !== "skip") ? null : "Nothing to install.";
      return finish({ action, title: `Copy OCR rule files into ${current.rules.folder}`, command: null, changes, blocked }, current.rules.files.map(({ path, current: hash, kit }) => ({ path, hash, kit })));
    }
    if (action.kind === "kit-root") {
      const stable = current.kit.stable;
      const moving = current.kit.profiles.filter(profile => stable?.profilesToMove.includes(profile.file));
      const changes: SetupChange[] = moving.map(profile => ({ path: profile.file, change: "update-file", detail: `kitRoot ${profile.kitRoot} → ${stable!.path}` }));
      const blocked = !stable || stable.status !== "installed" ? stable?.detail ?? "The stable kit link isn't available." : changes.length ? null : "Every profile already uses the stable kit path.";
      return finish({ action, title: "Point project profiles at the stable kit path", command: null, changes, blocked }, { moving: moving.map(profile => [profile.file, profile.kitRoot]), stable: stable && [stable.path, stable.target] });
    }
    const ocr = manifest.ocr;
    const spec = `${ocr.package}@${ocr.version}`;
    const command = `npm install -g ${spec}`;
    const installed = current.prefix ? await packageVersion(join(globalModules(current.prefix, host.platform), ...ocr.package.split("/"), "package.json")) : null;
    const npm = current.nodeExe ? npmCli(current.nodeExe, host.platform) : null;
    const npmFound = npm ? await isFile(npm.cli) : false;
    const blocked = !current.nodeExe ? "Node.js wasn't found on this host's PATH." : !npmFound ? `npm wasn't found beside Node (${npm!.cli}).`
      : installed === ocr.version ? `OCR ${ocr.version} is already installed.` : null;
    const changes: SetupChange[] = npm && current.nodeExe ? [{ path: current.nodeExe, change: "run-command", detail: `"${current.nodeExe}" "${npm.cli}" install -g ${spec}` }] : [];
    const title = installed ? `Change OCR ${installed} to ${ocr.version}` : `Install OCR ${ocr.version}`;
    return finish({ action, title, command, changes, blocked }, { installed, nodeExe: current.nodeExe, npm: npm?.cli ?? null });
  }

  async function plan(action: SetupAction): Promise<SetupPlan> {
    return (await prepare(action)).plan;
  }

  async function applySkills(action: Extract<SetupAction, { kind: "skills" }>, current: Awaited<ReturnType<typeof state>>) {
    const group = current.skills.find(entry => entry.group.provider === action.provider && entry.group.group === action.group)!.group;
    const folder = group.folder;
    const marker = await readMarker(folder);
    const done: string[] = [];
    const failed: string[] = [];
    for (const link of group.links) {
      if (link.status !== "missing" && link.status !== "outdated") continue;
      try {
        if (link.status === "outdated") {
          // Only Mission Control's own junction, still pointing where it left it, is removed; never recursively.
          const owned = marker.links[link.name];
          if ((await pathKind(link.path)) !== "link" || !owned || !samePath(await readlink(link.path), owned.target, host.platform)) throw new Error("it changed since the check");
          await unlink(link.path);
        }
        // symlink fails if anything appeared at this path since the check, so nothing is ever replaced.
        await symlink(link.target, link.path, "junction");
        marker.links[link.name] = { target: link.target, linkedAt: host.now().toISOString() };
        done.push(`${link.path} → ${link.target}`);
      } catch (error) {
        failed.push(`${link.path}: ${errorMessage(error)}`);
      }
    }
    if (done.length) await atomicWrite(join(folder, MARKER), `${JSON.stringify({ schemaVersion: 1, managedBy: "mission-control", note: "Skill links Mission Control created. Others in this folder are left alone.", links: marker.links }, null, 2)}\n`);
    return { done, failed, output: null, summary: `${done.length} link${done.length === 1 ? "" : "s"} created${failed.length ? `, ${failed.length} failed` : ""} for ${action.provider}.` };
  }

  async function applyRules(current: Awaited<ReturnType<typeof state>>) {
    const folder = current.rules.folder;
    const marker = await readOcrMarker(folder);
    const done: string[] = [];
    const failed: string[] = [];
    for (const file of current.rules.files) {
      if (file.status !== "missing" && file.status !== "outdated") continue;
      try {
        const content = await readFile(file.source);
        if (sha256(content) !== file.kit) throw new Error("the kit's copy changed since the check");
        await mkdir(dirname(file.destination), { recursive: true });
        if (file.status === "missing") await writeFile(file.destination, content, { flag: "wx" });
        else {
          // Re-read just before writing: a file edited since the check is left alone.
          const owned = marker.files[file.path];
          if (!owned || await fileHash(file.destination) !== owned.sha256) throw new Error("it was edited since the check");
          await atomicWrite(file.destination, content);
        }
        marker.files[file.path] = { sha256: sha256(content), writtenAt: host.now().toISOString() };
        done.push(file.destination);
      } catch (error) {
        failed.push(`${file.destination}: ${errorMessage(error)}`);
      }
    }
    if (done.length) await atomicWrite(join(folder, MARKER), `${JSON.stringify({ schemaVersion: 1, managedBy: "mission-control", note: "SHA-256 of each file as Mission Control last wrote it. A file that no longer matches is left alone.", files: marker.files }, null, 2)}\n`);
    return { done, failed, output: null, summary: `${done.length} rule file${done.length === 1 ? "" : "s"} written${failed.length ? `, ${failed.length} failed` : ""}.` };
  }

  async function applyKitRoot(current: Awaited<ReturnType<typeof state>>) {
    const stable = current.kit.stable!;
    const done: string[] = [];
    const failed: string[] = [];
    for (const file of stable.profilesToMove) {
      try {
        const markdown = await readFile(file, "utf8");
        // Only the frontmatter's kitRoot line changes; the plan's fingerprint already covered its old value.
        const next = markdown.replace(/^kitRoot:[^\r\n]*/m, `kitRoot: ${JSON.stringify(stable.path)}`);
        if (next === markdown) throw new Error("its kitRoot line wasn't found");
        await atomicWrite(file, next);
        done.push(`${file}: kitRoot → ${stable.path}`);
      } catch (error) {
        failed.push(`${file}: ${errorMessage(error)}`);
      }
    }
    return { done, failed, output: null, summary: `${done.length} profile${done.length === 1 ? "" : "s"} now use the stable kit path${failed.length ? `, ${failed.length} failed` : ""}. Re-point the skill links next.` };
  }

  async function applyOcrCli(plan: SetupPlan, current: Awaited<ReturnType<typeof state>>) {
    const ocr = manifest.ocr;
    const npm = npmCli(current.nodeExe!, host.platform);
    // Fixed arguments from the manifest only; nothing from the client reaches the command line.
    const result = await host.run(current.nodeExe!, [npm.cli, "install", "-g", `${ocr.package}@${ocr.version}`], { timeoutMs: INSTALL_TIMEOUT_MS });
    const installed = current.prefix ? await packageVersion(join(globalModules(current.prefix, host.platform), ...ocr.package.split("/"), "package.json")) : null;
    const output = scrubOutput(`${result.stdout}\n${result.stderr}`);
    const ok = result.code === 0 && installed === ocr.version;
    return {
      done: ok ? [plan.command!] : [], failed: ok ? [] : [`${plan.command}: ${result.code === 0 ? `npm finished, but OCR ${installed ?? "isn't"} installed where Mission Control looks` : `exit code ${result.code}`}`],
      output, summary: ok ? `Installed OCR ${ocr.version}.` : `OCR ${ocr.version} wasn't installed.`,
    };
  }

  /** Runs a confirmed install to the end. Never rejects: every failure becomes a result, so a caller that stopped waiting still gets it. */
  async function run(action: SetupAction, fresh: SetupPlan, current: Awaited<ReturnType<typeof state>>, startedAt: string): Promise<SetupFinished> {
    let outcome: { done: string[]; failed: string[]; output: string | null; summary: string };
    try {
      outcome = action.kind === "skills" ? await applySkills(action, current) : action.kind === "ocr-rules" ? await applyRules(current)
        : action.kind === "kit-root" ? await applyKitRoot(current) : await applyOcrCli(fresh, current);
    } catch (error) {
      outcome = { done: [], failed: [errorMessage(error)], output: null, summary: `${fresh.title} failed.` };
    }
    const result: SetupFinished = {
      action, running: false, ok: outcome.failed.length === 0, summary: outcome.summary,
      changes: [...outcome.done, ...outcome.failed.map(line => `Failed: ${line}`)], output: outcome.output,
      title: fresh.title, startedAt, finishedAt: host.now().toISOString(),
    };
    try {
      await appendLog(host, { at: result.finishedAt, action: fresh.title, summary: result.summary, ok: result.ok, changes: result.changes.map(hideSecrets), output: result.output });
    } catch (error) {
      // The changes above stand; only the record of them is missing.
      result.changes.push(`The install log couldn't be written: ${errorMessage(error)}`);
    }
    return result;
  }

  /**
   * Checks the confirmed plan, then installs. Replies with the result when it finishes within replyWithinMs; a slower
   * install (npm on a cold cache) replies "still running" and the screen follows it through read()'s running and lastResult.
   */
  async function apply(action: SetupAction, fingerprint: string): Promise<SetupResult> {
    if (running) throw new Error("Another install is running on this host. Wait for it to finish.");
    const startedAt = host.now().toISOString();
    // Claimed before the first await, so two confirmations can't both start.
    running = { action, title: "Checking the plan", startedAt };
    let fresh: SetupPlan;
    let current: Awaited<ReturnType<typeof state>>;
    try {
      ({ plan: fresh, current } = await prepare(action));
      if (fresh.fingerprint !== fingerprint) throw new Error("Something changed since you reviewed this. Check again and review the new plan.");
      if (fresh.blocked) throw new Error(fresh.blocked);
    } catch (error) { running = null; throw error; }
    running = { action, title: fresh.title, startedAt };
    const work = run(action, fresh, current, startedAt).then(result => { lastResult = result; running = null; return result; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>(done => { timer = setTimeout(() => done(null), options.replyWithinMs); });
    try {
      const finished = await Promise.race([work, late]);
      if (finished) { const { title: _title, finishedAt: _finished, ...result } = finished; return result; }
    } finally { clearTimeout(timer); }
    return { action, running: true, startedAt, ok: true, summary: `${fresh.title} is still running. This page follows it and shows the result when it finishes.`, changes: [], output: null };
  }

  return { read, plan, apply };
}

export function localSetupHost(): SetupHost {
  const env = process.env;
  const paseoHome = text(env.PASEO_HOME) ?? join(homedir(), ".paseo");
  return {
    home: homedir(), env, platform: process.platform, vaultRoot: defaultVaultPath,
    dataDir: join(paseoHome, "plugin-data", "mission-control"),
    now: () => new Date(),
    serverId: () => daemonServerId(),
    run: (file, args, options) => runExecutable(file, args, options),
  };
}

/** Settings → Setup: reads this host's dependencies on demand, and installs the three allowed items after confirmation. */
export function registerSetup(server: Pick<PluginServerContext, "handle">, host: SetupHost = localSetupHost(), options: { forgesInUse?: (paseo: import("@getpaseo/client").PaseoApi) => ReturnType<ForgesInUse> } = {}) {
  const service = createSetupService(host);
  server.handle(readSetup, (_input, { paseo }) => service.read(() => paseo.providers.snapshot(), options.forgesInUse ? () => options.forgesInUse!(paseo) : undefined));
  server.handle(planSetupAction, action => service.plan(action));
  server.handle(applySetupAction, ({ action, fingerprint }) => service.apply(action, fingerprint));
}
