import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { McpToggle, McpTogglePlan, McpToggleResult, McpToggleTarget, ToolProviderInventory } from "../shared/tools-inventory";
import { ConfigEditError, setJsoncListItem, setJsoncMember, setTomlKey, tomlTable } from "./config-edits";
import { parseJsonc, parseToml } from "./config-parsers";

// Turns one global MCP server on or off for Codex, OpenCode or Copilot CLI (task 17). Each change is planned and
// confirmed first, then re-read, backed up into Mission Control's own folder, written atomically and read back.
// Only the one key changes. Messages name files and keys, never file content, which may hold keys or tokens.

export interface ToggleHost {
  home: string;
  env: Record<string, string | undefined>;
  now(): Date;
  /** Mission Control's own folder for backups, never next to a config. */
  backupDir: string;
  /** `codex mcp list --json`, parsed; null when Codex isn't installed here. */
  codexMcpList(): Promise<{ servers: unknown } | { error: string } | null>;
  /** Replaces `path` with `content` in one step. Tests swap it to simulate a write that doesn't stick. */
  writeFile?(path: string, content: string): Promise<void>;
}

type Provider = McpToggleTarget["provider"];
type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;

function displayPath(home: string, path: string): string {
  const inside = relative(home, path);
  if (!inside) return "~";
  if (inside.startsWith("..") || isAbsolute(inside)) return path;
  return join("~", inside);
}

const fsCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "error";

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch (error) {
    if (fsCode(error) === "ENOENT" || fsCode(error) === "ENOTDIR") return null;
    throw new Error(`can't be read (${fsCode(error)})`);
  }
}

/**
 * A temporary file beside the target, then a rename, so readers see the old file or the new one, never half of it.
 * A symlinked config is written at its target, and the file keeps its permissions (a new one is private).
 */
export async function atomicWrite(path: string, content: string) {
  const target = await realpath(path).catch(() => path);
  const mode = await stat(target).then(info => info.mode & 0o777, () => 0o600);
  const temporary = join(dirname(target), `.${basename(target)}.mission-control-${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temporary, content, { flag: "wx", mode });
  try {
    await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export const fingerprint = (content: string | null) => content === null ? "missing" : createHash("sha256").update(content, "utf8").digest("hex");

/** Deep equality that ignores key order: TOML may list a new key after a subtable. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index]));
  const left = record(a), right = record(b);
  if (!left || !right) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
}

const bare = (name: string) => /^[A-Za-z0-9_-]+$/.test(name);

// ---------- where each server's switch is ----------

/** A switch Mission Control can change. `current` is the key's value (null: not set); for Copilot, whether the server is on. */
interface Located {
  provider: Provider;
  server: string;
  path: string;
  file: string;
  key: string;
  content: string | null;
  current: boolean | null;
  parse(content: string | null): unknown;
  /** The parsed config with the switch set, which the edited file must equal. */
  expect(parsed: unknown, enabled: boolean | null): unknown;
  edit(content: string | null, enabled: boolean | null): string;
}
type Resolution = Located | { readOnly: string; file: string | null; key: string | null };

async function load(host: Pick<ToggleHost, "home">, path: string, format: "toml" | "jsonc"): Promise<{ content: string | null; value: unknown } | { readOnly: string }> {
  const file = displayPath(host.home, path);
  let content: string | null;
  try { content = await readText(path); } catch (error) { return { readOnly: `${file} ${(error as Error).message}.` }; }
  if (content === null) return { content, value: null };
  try { return { content, value: format === "toml" ? parseToml(content) : parseJsonc(content) }; } catch {
    return { readOnly: `${file} couldn't be parsed, so it can't be changed safely.` };
  }
}

function setEnabled(parsed: unknown, path: string[], enabled: boolean | null) {
  const copy = structuredClone(parsed);
  let node = record(copy)!;
  for (const key of path) node = record(node[key])!;
  if (enabled === null) delete node.enabled; else node.enabled = enabled;
  return copy;
}

async function codex(host: Pick<ToggleHost, "home" | "env">, name: string): Promise<Resolution> {
  const path = join(text(host.env.CODEX_HOME) ?? join(host.home, ".codex"), "config.toml");
  const file = displayPath(host.home, path);
  const key = `[mcp_servers.${bare(name) ? name : JSON.stringify(name)}] enabled`;
  const loaded = await load(host, path, "toml");
  if ("readOnly" in loaded) return { ...loaded, file, key };
  const server = record(record(record(loaded.value)?.mcp_servers)?.[name]);
  if (loaded.content === null || !server) return { readOnly: "It comes from a Codex plugin, not config.toml, so it stays read-only.", file: null, key: null };
  let table: ReturnType<typeof tomlTable> = null;
  try { table = tomlTable(loaded.content, ["mcp_servers", name]); } catch { return { readOnly: `${file} couldn't be scanned safely; edit it by hand.`, file, key }; }
  if (!table) return { readOnly: `It's written inline in ${file} rather than as its own [mcp_servers.${name}] table; edit it by hand.`, file, key };
  if (server.enabled !== undefined && typeof server.enabled !== "boolean") return { readOnly: "Its enabled key isn't true or false; edit it by hand.", file, key };
  return {
    provider: "codex", server: name, path, file, key, content: loaded.content, current: server.enabled ?? null,
    parse: content => parseToml(content ?? ""),
    expect: (parsed, enabled) => setEnabled(parsed, ["mcp_servers", name], enabled),
    edit: (content, enabled) => setTomlKey(content ?? "", ["mcp_servers", name], "enabled", enabled),
  };
}

async function opencode(host: Pick<ToggleHost, "home" | "env">, name: string): Promise<Resolution> {
  const dir = join(text(host.env.XDG_CONFIG_HOME) ?? join(host.home, ".config"), "opencode");
  const key = `mcp${bare(name) ? `.${name}` : `[${JSON.stringify(name)}]`}.enabled`;
  const holders: { path: string; content: string; value: unknown }[] = [];
  // OpenCode merges these global files; a server defined in more than one would need every copy changed.
  for (const path of ["config.json", "opencode.json", "opencode.jsonc"].map(item => join(dir, item))) {
    const loaded = await load(host, path, "jsonc");
    if ("readOnly" in loaded) return { ...loaded, file: displayPath(host.home, path), key };
    if (loaded.content !== null && record(record(loaded.value)?.mcp)?.[name] !== undefined) holders.push({ path, content: loaded.content, value: loaded.value });
  }
  if (!holders.length) return { readOnly: "It isn't in OpenCode's global config files.", file: null, key: null };
  if (holders.length > 1) return { readOnly: `It's defined in ${holders.map(item => displayPath(host.home, item.path)).join(" and ")}; edit it by hand.`, file: null, key };
  const [{ path, content, value }] = holders;
  const file = displayPath(host.home, path);
  const server = record(record(record(value)?.mcp)?.[name]);
  if (!server) return { readOnly: "Its entry isn't an object; edit it by hand.", file, key };
  if (server.enabled !== undefined && typeof server.enabled !== "boolean") return { readOnly: "Its enabled key isn't true or false; edit it by hand.", file, key };
  return {
    provider: "opencode", server: name, path, file, key, content, current: server.enabled ?? null,
    parse: current => parseJsonc(current ?? ""),
    expect: (parsed, enabled) => setEnabled(parsed, ["mcp", name], enabled),
    edit: (current, enabled) => setJsoncMember(current ?? "", ["mcp", name, "enabled"], enabled === null ? null : String(enabled)),
  };
}

async function copilot(host: Pick<ToggleHost, "home" | "env">, name: string): Promise<Resolution> {
  const dir = join(host.home, ".copilot");
  const path = join(dir, "settings.json");
  const file = displayPath(host.home, path);
  const key = "disabledMcpServers";
  // Copilot's /mcp disable writes disabledMcpServers in <Copilot home>/settings.json (verified in Copilot CLI 1.0.80).
  if (text(host.env.COPILOT_HOME)) return { readOnly: "COPILOT_HOME is set, and Mission Control only reads ~/.copilot.", file: null, key: null };
  const servers = await load(host, join(dir, "mcp-config.json"), "jsonc");
  if ("readOnly" in servers) return { ...servers, file: null, key: null };
  if (!record(record(record(servers.value)?.mcpServers)?.[name])) {
    return {
      readOnly: name === "github-mcp-server"
        ? "Built in. Mission Control leaves built-in servers alone; use /mcp disable in Copilot or start it with --disable-builtin-mcps."
        : "It isn't in ~/.copilot/mcp-config.json (it's built in or from a plugin), so it stays read-only.",
      file: null, key: null,
    };
  }
  // Copilot merges the older config.json into its settings; a list there would still turn the server off.
  const legacy = await load(host, join(dir, "config.json"), "jsonc");
  if ("readOnly" in legacy) return { ...legacy, file, key };
  if (record(legacy.value) && Object.hasOwn(record(legacy.value)!, key)) return { readOnly: "~/.copilot/config.json also has disabledMcpServers, and Copilot merges both files; use /mcp in Copilot.", file, key };
  const settings = await load(host, path, "jsonc");
  if ("readOnly" in settings) return { ...settings, file, key };
  if (settings.content !== null && !record(settings.value)) return { readOnly: `${file} doesn't hold a JSON object; edit it by hand.`, file, key };
  const list = record(settings.value)?.[key];
  if (list !== undefined && !(Array.isArray(list) && list.every(item => typeof item === "string"))) return { readOnly: "disabledMcpServers isn't a list of names; edit it by hand.", file, key };
  return {
    provider: "copilot", server: name, path, file, key, content: settings.content, current: !(list ?? []).includes(name),
    parse: content => content === null ? {} : parseJsonc(content),
    expect(parsed, enabled) {
      const copy = structuredClone(record(parsed) ?? {});
      const names = ((copy[key] as string[] | undefined) ?? []).filter(item => enabled === false || item !== name);
      if (enabled === false && !names.includes(name)) names.push(name);
      if (names.length) copy[key] = names; else delete copy[key];
      return copy;
    },
    edit(content, enabled) {
      if (content === null) return `{\n  "${key}": [${JSON.stringify(name)}]\n}\n`;
      return setJsoncListItem(content, [key], name, enabled === false);
    },
  };
}

function locate(host: Pick<ToggleHost, "home" | "env">, provider: Provider, name: string): Promise<Resolution> {
  return provider === "codex" ? codex(host, name) : provider === "opencode" ? opencode(host, name) : copilot(host, name);
}

// ---------- inventory ----------

/** Adds each Codex, OpenCode and Copilot server's switch, or why it's read-only, to an inventory. */
export async function describeToggles(host: Pick<ToggleHost, "home" | "env">, providers: ToolProviderInventory[]): Promise<ToolProviderInventory[]> {
  return Promise.all(providers.map(async provider => {
    if (provider.id === "claude") return provider;
    const id = provider.id;
    // Copilot can list a plugin server under the same name as one in mcp-config.json; only that one gets the switch.
    const copilotConfig = displayPath(host.home, join(host.home, ".copilot", "mcp-config.json"));
    const servers = await Promise.all(provider.servers.map(async server => {
      if (id === "copilot" && server.source !== copilotConfig && server.source !== "Built in") {
        const toggle: McpToggle = { enabled: null, file: null, key: null, readOnly: "It comes from a Copilot plugin; Mission Control only turns servers on or off in ~/.copilot/mcp-config.json." };
        return { ...server, toggle };
      }
      const found = await locate(host, id, server.name);
      const toggle: McpToggle = "readOnly" in found
        ? { enabled: null, file: found.file, key: found.key, readOnly: found.readOnly }
        : { enabled: id === "copilot" ? found.current : found.current ?? true, file: found.file, key: found.key, readOnly: null };
      return { ...server, toggle };
    }));
    return { ...provider, servers };
  }));
}

// ---------- plan and apply ----------

function describe(provider: Provider, value: boolean | null) {
  if (provider === "copilot") return value === false ? "listed (off)" : "not listed (on)";
  return value === null ? "not set (on)" : value ? "true (on)" : "false (off)";
}

async function prepare(host: ToggleHost, target: McpToggleTarget) {
  const found = await locate(host, target.provider, target.server);
  if ("readOnly" in found) throw new Error(`${target.server} can't be changed here. ${found.readOnly}`);
  const desired = target.provider === "copilot" ? target.enabled ?? true : target.enabled;
  const unchanged = desired === found.current || (desired === true && found.current === null);
  let next = found.content ?? "";
  if (!unchanged) {
    try { next = found.edit(found.content, desired); } catch (error) {
      throw new Error(`${found.file} can't be edited safely here${error instanceof ConfigEditError ? ` (${error.message})` : ""}; nothing was written.`);
    }
    // The edited file must parse to the old config with only this switch changed.
    let ok = false;
    try { ok = same(found.parse(next), found.expect(found.parse(found.content), desired)); } catch { ok = false; }
    if (!ok) throw new Error(`Mission Control couldn't change only ${found.key} in ${found.file}, so nothing was written.`);
  }
  const undo: McpToggleTarget = { provider: target.provider, server: target.server, enabled: found.current };
  return { found, desired, unchanged, next, undo };
}

export async function planToggle(host: ToggleHost, target: McpToggleTarget): Promise<McpTogglePlan> {
  const { found, desired, unchanged } = await prepare(host, target);
  return {
    target, file: found.file, key: found.key, unchanged, fingerprint: fingerprint(found.content),
    before: describe(found.provider, found.current), after: describe(found.provider, unchanged ? found.current : desired),
  };
}

/** Backups hold the whole file, secrets included, so they're readable only by the user. */
async function backup(host: ToggleHost, found: Located): Promise<string | null> {
  if (found.content === null) return null;
  const folder = join(host.backupDir, found.provider);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const stamp = host.now().toISOString().replace(/[:.]/g, "-");
  for (let attempt = 0; attempt < 20; attempt++) {
    const path = join(folder, `${stamp}${attempt ? `-${attempt}` : ""}-${basename(found.path)}`);
    try {
      await writeFile(path, found.content, { flag: "wx", mode: 0o600 });
      return path;
    } catch (error) { if (fsCode(error) !== "EEXIST") throw new Error(`The backup couldn't be saved (${fsCode(error)}), so nothing was written.`); }
  }
  throw new Error("The backup couldn't be saved, so nothing was written.");
}

async function codexAgrees(host: ToggleHost, name: string, enabled: boolean): Promise<{ ok: true; note: string } | { ok: false; problem: string }> {
  const listed = await host.codexMcpList();
  if (!listed) return { ok: true, note: "Codex's command line wasn't found, so only the file was checked." };
  if ("error" in listed) return { ok: false, problem: "codex mcp list --json failed after the change" };
  const entry = (Array.isArray(listed.servers) ? listed.servers : []).map(record).find(item => item?.name === name);
  if (!entry) return { ok: false, problem: "codex mcp list --json doesn't list the server" };
  if (entry.enabled !== enabled) return { ok: false, problem: `codex mcp list --json reports it ${entry.enabled === false ? "off" : "on"}` };
  return { ok: true, note: `codex mcp list --json reports it ${enabled ? "on" : "off"}.` };
}

export async function applyToggle(host: ToggleHost, input: McpToggleTarget & { fingerprint: string }): Promise<McpToggleResult> {
  const target: McpToggleTarget = { provider: input.provider, server: input.server, enabled: input.enabled };
  // Read again just before writing; any change since the confirmation stops the write.
  const { found, desired, unchanged, next, undo } = await prepare(host, target);
  if (fingerprint(found.content) !== input.fingerprint) throw new Error(`${found.file} changed after you confirmed, so nothing was written. Review the change again.`);
  const result = { target, file: found.file, key: found.key, before: describe(found.provider, found.current), undo };
  if (unchanged) return { ...result, after: result.before, changed: false, backup: null, checks: ["Already in that state; nothing was written."] };

  const saved = await backup(host, found);
  const shownBackup = saved ? displayPath(host.home, saved) : null;
  const write = host.writeFile ?? atomicWrite;
  try { await write(found.path, next); } catch (error) {
    throw new Error(`${found.file} couldn't be written (${fsCode(error)}); it wasn't changed.${shownBackup ? ` Backup: ${shownBackup}.` : ""}`);
  }

  const checks: string[] = [];
  let problem: string | null = null;
  const written = await readText(found.path).catch(() => null);
  if (written !== next) problem = "the file doesn't hold what was written";
  else {
    try { if (!same(found.parse(written), found.expect(found.parse(found.content), desired))) problem = `${found.key} doesn't read back as expected`; } catch { problem = "the file no longer parses"; }
  }
  if (!problem) checks.push(`Read back ${found.file}: ${found.key} is ${describe(found.provider, desired)}.`);
  if (!problem && found.provider === "codex") {
    const agrees = await codexAgrees(host, found.server, desired ?? true);
    if (agrees.ok) checks.push(agrees.note); else problem = agrees.problem;
  }
  if (problem) {
    // Put the original back only while the file still holds exactly what this change wrote.
    let restored = false;
    const current = await readText(found.path).catch(() => null);
    if (current === next) {
      try {
        if (found.content === null) await unlink(found.path); else await write(found.path, found.content);
        restored = (await readText(found.path).catch(() => null)) === found.content;
      } catch { restored = false; }
    }
    const outcome = restored ? "The original file was put back." : "The file was left as it is now, because it no longer matches what was written.";
    throw new Error(`Read-back failed for ${found.file}: ${problem}. ${outcome}${shownBackup ? ` Backup: ${shownBackup}.` : ""}`);
  }
  return { ...result, after: describe(found.provider, desired), changed: true, backup: shownBackup, checks };
}

export function defaultBackupDir(env: Record<string, string | undefined> = process.env) {
  return join(text(env.PASEO_HOME) ?? join(homedir(), ".paseo"), "plugin-data", "mission-control", "config-backups");
}
