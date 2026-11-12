import type { PluginServerContext } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { runRuntimeDiagnostic, runtimeDiagnosticInput, type RuntimeDiagnosticResult } from "../shared/runtime-diagnostic";
import { defaultVaultPath } from "../shared/vault";
import { daemonServerId } from "./agent-names";
import { localServerId } from "./tasks";

type Volume = NonNullable<RuntimeDiagnosticResult["volume"]>;
type Database = { exec(sql: string): void; prepare(sql: string): { get(): unknown }; close(): void };
type Sqlite = { DatabaseSync: new (path: string) => Database };
type Identity = { ino: bigint; birth: bigint; directory: boolean };
const limitations = [
  "Synthetic same-process checks only; no cross-process or all-writer exclusion certification.",
  "No real task, lock, decision or recovery operation was accessed.",
  "The 30-second deadline is cooperative; synchronous OS calls cannot be forcibly interrupted.",
  "Runtime identity is observed here; installed source revision must be correlated with the managed plugin receipt.",
  "Path ownership checks are not an OS security fence against another privileged process mutating paths concurrently.",
];
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);
const code = (error: unknown) => (error as { code?: string })?.code;
async function identity(path: string): Promise<Identity> {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))) throw new Error("Unsafe synthetic path type or link count.");
  return { ino: stat.ino, birth: stat.birthtimeNs, directory: stat.isDirectory() };
}
async function unchanged(path: string, expected: Identity) {
  const actual = await identity(path);
  if (actual.ino !== expected.ino || actual.birth !== expected.birth || actual.directory !== expected.directory) throw new Error("Synthetic path ownership changed; retained for inspection.");
}
async function canonicalDirectory(path: string) {
  const absolute = resolve(path);
  for (let at = absolute;; at = dirname(at)) {
    const info = await lstat(at);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Directory ancestor is not an ordinary directory.");
    if (at === dirname(at)) break;
  }
  const canonical = await realpath(absolute);
  if (canonical.toLowerCase() !== absolute.toLowerCase()) throw new Error("Directory resolves through an alias.");
  return canonical;
}

// Fixed program, data on stdin only. Require a real drive-letter NTFS volume;
// reject SUBST/mapped/network roots and every reparse ancestor (including mounts).
const volumeScript = String.raw`
$ErrorActionPreference = 'Stop'
$paths = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$result = @()
foreach ($p in $paths) {
  if ($p -notmatch '^[A-Za-z]:\\') { throw 'Only local drive-letter paths are supported' }
  $at = Get-Item -LiteralPath $p -Force
  while ($null -ne $at) {
    if (($at.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse paths are unsupported' }
    $at = $at.Parent
  }
  $root = [IO.Path]::GetPathRoot($p)
  $drive = $root.Substring(0,2)
  $volumes = @(Get-CimInstance Win32_Volume | Where-Object { $_.DriveLetter -eq $drive })
  $disks = @(Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq $drive })
  if ($volumes.Count -ne 1 -or $disks.Count -ne 1) { throw 'Ambiguous or substituted volume' }
  $v = $volumes[0]; $d = $disks[0]
  if ($v.DriveType -ne 3 -or $d.DriveType -ne 3 -or $d.ProviderName -or $v.FileSystem -ne 'NTFS' -or !$v.DeviceID -or $null -eq $v.SerialNumber) { throw 'Requires a known local NTFS volume' }
  $result += @{ id=[string]$v.DeviceID; serial=[string]$v.SerialNumber; filesystem='NTFS'; root=$root }
}
ConvertTo-Json -InputObject $result -Compress
`;
export async function localVolume(vault: string, parent: string): Promise<Volume> {
  if (process.platform !== "win32") throw new Error("Runtime diagnostic supports verified local Windows NTFS only.");
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const output = await new Promise<string>((accept, reject) => {
    const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", volumeScript],
      { windowsHide: true, timeout: 5000, maxBuffer: 16384, encoding: "utf8" }, (error, stdout, stderr) => error ? reject(new Error(`Local volume metadata unavailable (${error.code ?? "error"}): ${stderr.slice(0, 300)}`)) : accept(stdout));
    child.stdin?.on("error", reject);
    child.stdin?.end(JSON.stringify([vault, parent]));
  });
  return parseVolumeEvidence(output);
}

export function parseVolumeEvidence(output: string): Volume {
  const rows: unknown = JSON.parse(output.replace(/^\uFEFF/, ""));
  if (!Array.isArray(rows) || rows.length !== 2) throw new Error("Incomplete local-volume evidence.");
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id.startsWith("\\\\?\\Volume{") || typeof row.serial !== "string" || !row.serial || row.filesystem !== "NTFS" || typeof row.root !== "string" || !/^[A-Za-z]:\\$/.test(row.root)) throw new Error("Invalid local-volume evidence.");
  }
  if (rows[0].id !== rows[1].id || rows[0].serial !== rows[1].serial || rows[0].root !== rows[1].root) throw new Error("Vault and synthetic parent are on different volumes.");
  return rows[0];
}

type Dependencies = {
  vaultPath: string;
  serverId(): Promise<string>;
  volume?: typeof localVolume;
  sqlite?: () => Promise<Sqlite>;
  now?: () => number;
};
// Dependency injection is local test plumbing, never part of the public RPC.
export function createRuntimeDiagnostic(deps: Dependencies) {
  let active = false;
  return async (raw: unknown): Promise<RuntimeDiagnosticResult> => {
    const input = runtimeDiagnosticInput.parse(raw);
    if (active) throw new Error("A runtime diagnostic is already active; do not retry an unconfirmed probe.");
    active = true;
    const now = deps.now ?? Date.now;
    const started = now();
    const result: RuntimeDiagnosticResult = {
      probeVersion: "mc-runtime-v1", serverId: input.serverId, startedAt: new Date().toISOString(), durationMs: 0,
      status: "failed", runtime: { execPath: process.execPath, node: process.version, electron: process.versions.electron ?? null, modules: process.versions.modules ?? null, pid: process.pid, ppid: process.ppid },
      volume: null, directory: null, checks: [], error: null, cleanup: "not-created", limitations: [...limitations],
    };
    const deadline = () => { if (now() - started > 30000) throw new Error("Cooperative diagnostic deadline exceeded; do not blindly repeat."); };
    let parent: string | undefined;
    let parentIdentity: Identity | undefined;
    let directoryIdentity: Identity | undefined;
    const files = new Map<string, Identity>();
    const databases: Database[] = [];
    let handlesClosed = true;
    const guard = async () => {
      if (!parent || !parentIdentity || !result.directory || !directoryIdentity) throw new Error("Synthetic ownership unavailable.");
      await canonicalDirectory(parent);
      await unchanged(parent, parentIdentity);
      await unchanged(result.directory, directoryIdentity);
    };
    try {
      if (input.serverId !== await deps.serverId()) throw new Error("Requested host does not match the running plugin host.");
      deadline();
      const vault = await canonicalDirectory(deps.vaultPath);
      parent = dirname(vault);
      if (parent === vault || vault.toLowerCase().split(/[\\/]/).includes("tasks")) throw new Error("Vault has no safe sibling diagnostic location.");
      await canonicalDirectory(parent);
      parentIdentity = await identity(parent);
      result.volume = await (deps.volume ?? localVolume)(vault, parent);
      deadline();
      result.checks.push("Local vault volume and synthetic parent verified.");
      const moduleName = "node:sqlite";
      const sqlite: Sqlite = await (deps.sqlite ? deps.sqlite() : import(moduleName));
      if (typeof sqlite.DatabaseSync !== "function") throw new Error("node:sqlite DatabaseSync is unavailable.");
      result.checks.push("node:sqlite loaded in the handler process.");
      deadline();
      await canonicalDirectory(parent);
      await unchanged(parent, parentIdentity);
      const directory = join(parent, `.mission-control-runtime-${randomUUID()}`);
      await mkdir(directory, { mode: 0o700 }); // Exclusive: never adopts an existing directory.
      result.directory = directory;
      result.cleanup = "retained";
      directoryIdentity = await identity(directory);
      for (const name of ["probe.sqlite", "exclusive.txt"]) {
        await guard(); deadline();
        const path = join(directory, name);
        const handle = await open(path, "wx", 0o600);
        try {
          const stat = await handle.stat({ bigint: true });
          files.set(name, { ino: stat.ino, birth: stat.birthtimeNs, directory: false });
          if (name === "exclusive.txt") { await handle.writeFile("synthetic-runtime-v1\n"); await handle.sync(); }
        } finally { await handle.close(); }
        await unchanged(path, files.get(name)!);
      }
      await guard(); deadline();
      let collided = false;
      try { const unexpected = await open(join(directory, "exclusive.txt"), "wx"); await unexpected.close(); }
      catch (error) { if (code(error) !== "EEXIST") throw error; collided = true; }
      if (!collided) throw new Error("Exclusive file creation did not reject an existing file.");
      const reader = await open(join(directory, "exclusive.txt"), "r");
      try { if (await reader.readFile("utf8") !== "synthetic-runtime-v1\n") throw new Error("Synthetic file readback differs."); } finally { await reader.close(); }
      result.checks.push("Exclusive file creation, sync and readback passed.");
      await guard(); deadline();
      const databasePath = join(directory, "probe.sqlite");
      await unchanged(databasePath, files.get("probe.sqlite")!);
      const first = new sqlite.DatabaseSync(databasePath); databases.push(first);
      const second = new sqlite.DatabaseSync(databasePath); databases.push(second);
      // MEMORY journal avoids unowned sidecar cleanup. This is a basic lock smoke,
      // not a durability/WAL/crash test or a substitute for the run-lock suite.
      first.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES(7)");
      second.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY");
      if ((second.prepare("SELECT value FROM probe").get() as { value?: number })?.value !== 7) throw new Error("SQLite readback differs.");
      first.exec("BEGIN IMMEDIATE");
      let busy = false;
      try { second.exec("BEGIN IMMEDIATE"); } catch (error) { if ((error as { errcode?: number }).errcode !== 5) throw error; busy = true; }
      if (!busy) throw new Error("SQLite did not reject a competing transaction.");
      first.exec("ROLLBACK"); second.exec("BEGIN IMMEDIATE; ROLLBACK");
      deadline();
      result.checks.push("SQLite read/write, contention, rollback and reacquisition passed.");
      result.status = "passed";
    } catch (error) { result.error = message(error); }
    finally {
      for (const database of databases.reverse()) {
        try { database.close(); } catch (error) { handlesClosed = false; result.error ??= message(error); }
      }
      if (result.directory && directoryIdentity) {
        try {
          if (!handlesClosed) throw new Error("Database close failed; synthetic files retained.");
          await guard();
          const entries = await readdir(result.directory);
          if (entries.some(name => !files.has(name))) throw new Error("Unexpected synthetic contents; retained for inspection.");
          for (const [name, expected] of files) { await guard(); await unchanged(join(result.directory, name), expected); }
          for (const [name, expected] of files) {
            await guard(); await unchanged(join(result.directory, name), expected);
            await unlink(join(result.directory, name));
          }
          await guard(); await rmdir(result.directory);
          result.cleanup = "removed";
        } catch (error) { result.error = [result.error, message(error)].filter(Boolean).join("; ").slice(0, 500); }
      }
      if (result.error || result.cleanup === "retained") result.status = "failed";
      result.durationMs = Math.max(0, now() - started);
      active = false;
    }
    return result;
  };
}

export function registerRuntimeDiagnostic(server: PluginServerContext) {
  const probe = createRuntimeDiagnostic({ vaultPath: defaultVaultPath, serverId: async () => {
    const [native, vault] = await Promise.all([daemonServerId(), localServerId()]);
    if (native !== vault) throw new Error("Native host and configured vault identity differ.");
    return native;
  } });
  server.handle(runRuntimeDiagnostic, input => probe(input));
}
