import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  applyMcpToggle,
  planMcpToggle,
  readToolsInventory,
  type McpServerEntry,
  type RuleFileEntry,
  type SkillFolderEntry,
  type ToolProviderInventory,
  type ToolsInventory,
  type ToolSearchVerdict,
} from "../shared/tools-inventory";
import { ConfigParseError, parseJsonc, parseToml } from "./config-parsers";
import { applyToggle, defaultBackupDir, describeToggles, planToggle, type ToggleHost } from "./mcp-toggle";

// Inventory of each provider's global setup (task 6 report, section 3). Reading writes no file, starts no MCP server,
// and runs no command that changes state; the only command run is `codex mcp list --json`. Turning a server on or off
// is the one change, and it lives in mcp-toggle.ts.
// Secrets never leave this module: environment values, headers, tokens and arguments are read past, not copied.

const PREVIEW_LIMIT = 64 * 1024;
const SKILL_HEADER_LIMIT = 16 * 1024;
const MAX_SKILLS_PER_FOLDER = 500;
const PROBE_TIMEOUT_MS = 4000;

type Health = McpServerEntry["health"];
type Check = { kind: "command"; command: string } | { kind: "url"; url: string } | null;
/** A server before its health check. `check` holds the raw command or URL and is dropped before returning. */
export type ServerDraft = Omit<McpServerEntry, "health"> & { check: Check; health?: Health };

export interface InventoryHost {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** Claude Code's file-based managed settings, or null where there are none. */
  claudeManagedSettings: string | null;
  now(): Date;
  /** Finds a stdio server's command without running it. */
  findCommand(command: string): Promise<"found" | "missing" | "unknown">;
  probeUrl(url: string): Promise<Health>;
  /** `codex mcp list --json`, parsed; null when Codex isn't installed here. */
  codexMcpList(): Promise<{ servers: unknown } | { error: string } | null>;
}

// ---------- small helpers ----------

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const sortByName = <T extends { name: string }>(items: T[]) => items.sort((a, b) => a.name.localeCompare(b.name));

/** The command's file name only: `C:\tools\gortex.exe` → `gortex.exe`. Arguments are never kept. */
export function commandName(command: string): string {
  return command.trim().split(/[\\/]/).pop() || command.trim();
}

const KEY_LIKE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_\-.~%+=]{24,}$/;

/** Scheme, host, port and path. Drops user info, the query and the fragment, and masks key-like path segments. */
export function sanitizeUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:") return `${url.protocol}…`;
  const path = url.pathname.split("/").map(segment => KEY_LIKE.test(segment) ? "…" : segment).join("/");
  const hidden = url.username || url.password || url.search || url.hash;
  return `${url.protocol}//${url.host}${path === "/" ? "" : path}${hidden ? " (credentials or parameters hidden)" : ""}`;
}

/**
 * The address the health check requests: the configured HTTP(S) URL without user info, query or fragment,
 * so the check sends no credentials. The path is kept because servers route on it. Null for other schemes.
 */
export function probeAddress(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

function displayPath(home: string, path: string): string {
  const inside = relative(home, path);
  if (!inside) return "~";
  if (inside.startsWith("..") || isAbsolute(inside)) return path;
  return join("~", inside);
}

type Loaded = { value: unknown } | { missing: true } | { error: string };

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new Error(`can't be read (${code ?? "error"})`);
  }
}

/** Reads and parses one config file. Errors name the file and a position, never its content. */
async function load(host: InventoryHost, path: string, format: "json" | "jsonc" | "toml"): Promise<Loaded> {
  let content: string | null;
  try { content = await readText(path); } catch (error) { return { error: `${displayPath(host.home, path)} ${(error as Error).message}.` }; }
  if (content === null) return { missing: true };
  try {
    return { value: format === "toml" ? parseToml(content) : parseJsonc(content) };
  } catch (error) {
    return { error: `${displayPath(host.home, path)}: ${error instanceof ConfigParseError ? error.message : "couldn't be parsed."}` };
  }
}

const valueOf = (loaded: Loaded): unknown => "value" in loaded ? loaded.value : null;
const errorOf = (loaded: Loaded): string[] => "error" in loaded ? [loaded.error] : [];

async function isDirectory(path: string) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function entries(path: string) {
  try { return await readdir(path, { withFileTypes: true }); } catch { return []; }
}

/** Files under `root` whose names match, depth-limited, skipping hidden folders. */
async function findFiles(root: string, match: (name: string) => boolean, depth = 4): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await entries(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0 && !entry.name.startsWith(".") && entry.name !== "node_modules") found.push(...await findFiles(path, match, depth - 1));
    } else if (entry.isFile() && match(entry.name)) found.push(path);
  }
  return found.sort();
}

// ---------- skills ----------

/** `name` and `description` from a SKILL.md front matter block; folded and literal block values are joined. */
export function skillFrontMatter(content: string): { name: string | null; description: string | null } {
  const block = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const fields: Record<string, string> = {};
  if (block) {
    const lines = block[1].split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index]);
      if (!field) continue;
      let value = field[2].trim();
      if (/^[>|][+-]?$/.test(value)) {
        const parts: string[] = [];
        while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]) || !lines[index + 1].trim())) parts.push(lines[++index].trim());
        value = parts.filter(Boolean).join(value.startsWith(">") ? " " : "\n");
      } else if (/^".*"$/.test(value)) {
        try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
      } else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replaceAll("''", "'");
      fields[field[1]] = value;
    }
  }
  return { name: fields.name?.trim() || null, description: fields.description?.trim() || null };
}

async function readSkillHeader(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, "utf8");
    return content.slice(0, SKILL_HEADER_LIMIT);
  } catch { return null; }
}

/** Skills are folders holding a SKILL.md; the folder name stands in for a missing `name`. */
async function skillFolder(host: InventoryHost, label: string, path: string, note: string | null = null, disabled: ReadonlySet<string> = new Set()): Promise<SkillFolderEntry> {
  const exists = await isDirectory(path);
  const skills: SkillFolderEntry["skills"] = [];
  if (exists) {
    for (const entry of await entries(path)) {
      if (skills.length >= MAX_SKILLS_PER_FOLDER) break;
      if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
      const directory = join(path, entry.name);
      const header = await readSkillHeader(join(directory, "SKILL.md"));
      if (header === null) continue;
      const meta = skillFrontMatter(header);
      const off = disabled.has(normalize(directory)) || disabled.has(normalize(join(directory, "SKILL.md")));
      skills.push({ name: meta.name ?? entry.name, description: meta.description ?? "", path: displayPath(host.home, directory), enabled: !off });
    }
  }
  return { label, path: displayPath(host.home, path), exists, note, skills: sortByName(skills) };
}

const normalize = (path: string) => resolve(path).replaceAll("\\", "/").toLowerCase();

/** Each `skills` folder a provider's plugin cache holds, one entry per folder. */
async function pluginSkillFolders(host: InventoryHost, root: string, label: string): Promise<SkillFolderEntry[]> {
  const folders: string[] = [];
  async function walk(path: string, depth: number) {
    for (const entry of await entries(path)) {
      // Codex keeps replaced plugin versions in plugin-backup-* folders; it doesn't load them.
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules" || entry.name.startsWith("plugin-backup-")) continue;
      const child = join(path, entry.name);
      if (entry.name === "skills") folders.push(child);
      else if (depth > 0) await walk(child, depth - 1);
    }
  }
  await walk(root, 4);
  const result: SkillFolderEntry[] = [];
  for (const folder of folders.sort()) {
    // Sync buckets are named by account IDs, which say nothing to the reader.
    const name = relative(root, dirname(folder)).split(/[\\/]/).filter(part => !/^[0-9a-f-]{20,}(_[0-9a-f-]+)?$/i.test(part)).join(" / ");
    const entry = await skillFolder(host, `${label}: ${name || basename(dirname(folder))}`, folder, "From a plugin; listed whether or not the plugin is turned on.");
    if (entry.skills.length) result.push(entry);
  }
  return result;
}

// ---------- rule files ----------

async function ruleFile(host: InventoryHost, label: string, path: string, state: "active" | "inactive", note: string | null = null): Promise<RuleFileEntry> {
  let content: string | null = null;
  let size: number | null = null;
  try {
    const info = await stat(path);
    if (info.isFile()) { size = info.size; content = await readFile(path, "utf8"); }
  } catch { /* missing */ }
  if (content === null) return { label, path: displayPath(host.home, path), state: "missing", note, size: null, preview: null, truncated: false };
  return {
    label, path: displayPath(host.home, path), state, note, size,
    preview: content.slice(0, PREVIEW_LIMIT), truncated: content.length > PREVIEW_LIMIT,
  };
}

const exists = async (path: string) => { try { return (await stat(path)).isFile(); } catch { return false; } };

// ---------- health ----------

async function withHealth(host: InventoryHost, drafts: ServerDraft[]): Promise<McpServerEntry[]> {
  return Promise.all(drafts.map(async ({ check, health, ...server }) => {
    if (health) return { ...server, health };
    if (!check) return { ...server, health: { state: "unknown" as const, label: "Not checked" } };
    if (check.kind === "url") {
      const address = probeAddress(check.url);
      if (!address) return { ...server, health: { state: "unknown" as const, label: "Not an HTTP address; not checked" } };
      return { ...server, health: await host.probeUrl(address) };
    }
    const found = await host.findCommand(check.command);
    // Agents inherit Paseo's PATH, so that's the one searched.
    const label = { found: "Command found (not started)", missing: "Command not found on Paseo's PATH", unknown: "Command not checked" }[found];
    return { ...server, health: { state: found === "found" ? "ok" as const : found === "missing" ? "error" as const : "unknown" as const, label } };
  }));
}

function transportFromUrl(url: string | null, type: string | null): McpServerEntry["transport"] {
  if (type === "sse") return "sse";
  if (url) return "http";
  return "unknown";
}

// ---------- Claude Code ----------

const TRUTHY = /^(1|true|yes|on)$/i;

/** Where Claude Code's own environment for a setting comes from, highest precedence first. */
function claudeEnvironment(host: InventoryHost, settings: { label: string; value: unknown }[]) {
  return (name: string): { value: string; source: string } | null => {
    for (const { label, value } of settings) {
      const env = record(record(value)?.env);
      const found = env?.[name];
      if (typeof found === "string") return { value: found, source: label };
    }
    const found = host.env[name];
    return found === undefined ? null : { value: found, source: "the environment of Paseo's daemon" };
  };
}

export function claudeToolSearch(env: ReturnType<typeof claudeEnvironment>, alwaysLoaded: string[]): ToolSearchVerdict {
  // An empty value counts as unset.
  const raw = env("ENABLE_TOOL_SEARCH");
  const setting = raw?.value.trim() ? raw : null;
  const betas = env("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS");
  const baseUrl = env("ANTHROPIC_BASE_URL");
  const how = "Remove ENABLE_TOOL_SEARCH or set it to true (or auto) in the env block of ~/.claude/settings.json.";
  const always = alwaysLoaded.length ? ` Always loaded, so not deferred: ${alwaysLoaded.join(", ")}.` : "";
  const value = setting?.value.trim().toLowerCase() ?? "";
  const shown = /^(true|false|1|0|auto(:\d{1,3})?)$/.test(value) ? value : "an unrecognised value";
  if (setting && (value === "false" || value === "0")) return { verdict: "off", reason: `ENABLE_TOOL_SEARCH is ${shown} in ${setting.source}.`, howToEnable: how };
  if (betas && TRUTHY.test(betas.value.trim())) {
    return { verdict: "off", reason: `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is set in ${betas.source}.`, howToEnable: `Remove CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS from ${betas.source}.` };
  }
  let firstParty = true;
  if (baseUrl && baseUrl.value.trim()) {
    try { firstParty = /(^|\.)anthropic\.com$/i.test(new URL(baseUrl.value.trim()).hostname); } catch { firstParty = false; }
  }
  const explicitOn = value === "true" || value === "1" || value.startsWith("auto");
  if (!firstParty && !explicitOn) {
    return { verdict: "off", reason: `ANTHROPIC_BASE_URL in ${baseUrl!.source} points to a non-Anthropic address, which turns tool search off.`, howToEnable: "Set ENABLE_TOOL_SEARCH to true in the env block of ~/.claude/settings.json, if the endpoint supports it." };
  }
  if (value.startsWith("auto")) {
    return { verdict: "on", reason: `ENABLE_TOOL_SEARCH is ${shown} in ${setting!.source}: tools are deferred once they pass a share of the context.${always}`, howToEnable: "Already on. Set it to true to always defer MCP tools." };
  }
  if (setting && !explicitOn) return { verdict: "unknown", reason: `ENABLE_TOOL_SEARCH is ${shown} in ${setting.source}.${always}`, howToEnable: how };
  return {
    verdict: "on",
    reason: `${setting ? `ENABLE_TOOL_SEARCH is ${shown} in ${setting.source}` : "On by default: ENABLE_TOOL_SEARCH isn't set"}. MCP tools load on demand.${always}`,
    howToEnable: "Already on.",
  };
}

export function claudeServers(config: unknown, credentials: unknown, needsAuth: unknown, source: string): ServerDraft[] {
  const servers = record(record(config)?.mcpServers) ?? {};
  const projects = record(record(config)?.projects) ?? {};
  const oauth = Object.values(record(record(credentials)?.mcpOAuth) ?? {}).map(record);
  const pending = record(needsAuth) ?? {};
  return sortByName(Object.entries(servers).map(([name, raw]): ServerDraft => {
    const server = record(raw) ?? {};
    const type = text(server.type);
    const command = text(server.command);
    const url = text(server.url);
    const transport = type === "stdio" || (!type && command) ? "stdio" : type === "http" || type === "sse" ? type : transportFromUrl(url, type);
    const turnedOff = Object.values(projects).filter(project => {
      const disabled = record(project)?.disabledMcpServers;
      return Array.isArray(disabled) && disabled.includes(name);
    }).length;
    const signedIn = oauth.some(entry => entry?.serverName === name && typeof entry.accessToken === "string" && entry.accessToken.length > 0);
    const signIn = transport === "stdio" ? "not-needed" : Object.hasOwn(pending, name) ? "needs-sign-in" : signedIn ? "signed-in" : "unknown";
    return {
      name, transport, enabled: true,
      enabledNote: turnedOff ? `Turned off in ${turnedOff} project${turnedOff === 1 ? "" : "s"}.` : null,
      signIn, command: command ? commandName(command) : null, url: url ? sanitizeUrl(url) : null, source,
      notes: server.alwaysLoad === true ? ["Always loaded (alwaysLoad), so tool search doesn't defer it."] : [],
      check: transport === "stdio" && command ? { kind: "command", command } : url ? { kind: "url", url } : null,
    };
  }));
}

async function claudeInventory(host: InventoryHost): Promise<ToolProviderInventory> {
  const dir = text(host.env.CLAUDE_CONFIG_DIR) ?? join(host.home, ".claude");
  const configPath = text(host.env.CLAUDE_CONFIG_DIR) ? join(dir, ".claude.json") : join(host.home, ".claude.json");
  const [config, credentials, needsAuth, settings, local, managed] = await Promise.all([
    load(host, configPath, "json"),
    load(host, join(dir, ".credentials.json"), "json"),
    load(host, join(dir, "mcp-needs-auth-cache.json"), "json"),
    load(host, join(dir, "settings.json"), "json"),
    load(host, join(dir, "settings.local.json"), "json"),
    host.claudeManagedSettings ? load(host, host.claudeManagedSettings, "json") : Promise.resolve({ missing: true } as Loaded),
  ]);
  const source = displayPath(host.home, configPath);
  const drafts = claudeServers(valueOf(config), valueOf(credentials), valueOf(needsAuth), source);
  const env = claudeEnvironment(host, [
    { label: "managed settings", value: valueOf(managed) },
    { label: displayPath(host.home, join(dir, "settings.local.json")), value: valueOf(local) },
    { label: displayPath(host.home, join(dir, "settings.json")), value: valueOf(settings) },
  ]);
  const rulesDir = join(dir, "rules");
  const rules = [await ruleFile(host, "CLAUDE.md", join(dir, "CLAUDE.md"), "active")];
  for (const path of await findFiles(rulesDir, name => name.toLowerCase().endsWith(".md"))) {
    rules.push(await ruleFile(host, `rules/${relative(rulesDir, path).replaceAll("\\", "/")}`, path, "active"));
  }
  const synced = [];
  for (const entry of await entries(join(dir, "skills", "synced"))) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) synced.push(await skillFolder(host, "Synced skills", join(dir, "skills", "synced", entry.name), "Synced from your Claude account."));
  }
  const skillFolders = [
    await skillFolder(host, "Skills", join(dir, "skills")),
    ...synced,
    // Installed and synced plugins only; marketplaces/ holds plugins that aren't installed.
    ...await pluginSkillFolders(host, join(dir, "plugins", "cache"), "Plugin"),
    ...await pluginSkillFolders(host, join(dir, "plugins", "synced"), "Synced plugin"),
  ];
  return {
    id: "claude", name: "Claude Code", configPath: source,
    found: !("missing" in config) || rules.some(rule => rule.state !== "missing") || skillFolders.some(folder => folder.exists),
    errors: [...errorOf(config), ...errorOf(settings), ...errorOf(local), ...errorOf(managed)],
    servers: await withHealth(host, drafts), rules, skillFolders,
    toolSearch: claudeToolSearch(env, drafts.filter(server => server.notes.length).map(server => server.name)),
    notes: ["User-scope servers from ~/.claude.json. Claude Code has no global off switch for them; /mcp turns one off per project. Servers from Claude plugins and claude.ai connectors aren't listed."],
  };
}

// ---------- Codex ----------

const CODEX_AUTH: Record<string, McpServerEntry["signIn"]> = {
  unsupported: "not-needed", not_logged_in: "needs-sign-in", bearer_token: "signed-in", o_auth: "signed-in", oauth: "signed-in",
};

export function codexServers(config: unknown, listed: unknown, source: string): ServerDraft[] {
  const servers = record(record(config)?.mcp_servers) ?? {};
  const drafts = new Map<string, ServerDraft>();
  for (const [name, raw] of Object.entries(servers)) {
    const server = record(raw) ?? {};
    const command = text(server.command);
    const url = text(server.url);
    drafts.set(name, {
      name, transport: command ? "stdio" : url ? "http" : "unknown",
      enabled: server.enabled !== false, enabledNote: null,
      signIn: command ? "not-needed" : "unknown",
      command: command ? commandName(command) : null, url: url ? sanitizeUrl(url) : null, source, notes: [],
      check: command ? { kind: "command", command } : url ? { kind: "url", url } : null,
    });
  }
  // The CLI adds plugin servers and sign-in state; its `enabled` is what Codex will actually use.
  for (const raw of Array.isArray(listed) ? listed : []) {
    const entry = record(raw);
    const name = text(entry?.name);
    if (!entry || !name) continue;
    const transport = record(entry.transport) ?? {};
    const command = text(transport.command);
    const url = text(transport.url);
    const auth = text(entry.auth_status);
    const existing = drafts.get(name);
    const signIn = auth ? CODEX_AUTH[auth.toLowerCase()] ?? "unknown" : existing?.signIn ?? "unknown";
    const enabled = typeof entry.enabled === "boolean" ? entry.enabled : existing?.enabled ?? null;
    const reason = text(entry.disabled_reason);
    const enabledNote = enabled === false && reason && /^[\w .,:-]{1,80}$/.test(reason) ? `Reason: ${reason}.` : null;
    if (existing) { drafts.set(name, { ...existing, signIn, enabled, enabledNote }); continue; }
    drafts.set(name, {
      name, transport: command ? "stdio" : url ? "http" : "unknown", enabled, enabledNote, signIn,
      command: command ? commandName(command) : null, url: url ? sanitizeUrl(url) : null, source: "Codex plugin", notes: [],
      check: command ? { kind: "command", command } : url ? { kind: "url", url } : null,
    });
  }
  return sortByName([...drafts.values()]);
}

export function codexToolSearch(config: unknown, modelsCache: unknown): ToolSearchVerdict {
  const settings = record(config) ?? {};
  const profile = text(settings.profile);
  const model = (profile ? text(record(record(settings.profiles)?.[profile])?.model) : null) ?? text(settings.model);
  const how = "Codex always uses tool search when the model supports it; there's no setting. Pick a model that supports it.";
  if (!model) return { verdict: "unknown", reason: "No model is set in config.toml, so it depends on Codex's default model.", howToEnable: how };
  const models = record(modelsCache)?.models;
  const known = Array.isArray(models) ? models.map(record).find(entry => entry?.slug === model) : undefined;
  if (!known || typeof known.supports_search_tool !== "boolean") return { verdict: "unknown", reason: `The model ${model} isn't in Codex's model cache.`, howToEnable: how };
  return known.supports_search_tool
    ? { verdict: "on", reason: `Always on in Codex, and ${model} supports it. MCP tools are deferred.`, howToEnable: "Already on." }
    : { verdict: "off", reason: `${model} doesn't support tool search.`, howToEnable: how };
}

async function codexInventory(host: InventoryHost): Promise<ToolProviderInventory> {
  const dir = text(host.env.CODEX_HOME) ?? join(host.home, ".codex");
  const configPath = join(dir, "config.toml");
  const [config, modelsCache, listed] = await Promise.all([
    load(host, configPath, "toml"), load(host, join(dir, "models_cache.json"), "json"), host.codexMcpList(),
  ]);
  const errors = errorOf(config);
  if (listed && "error" in listed) errors.push(listed.error);
  const drafts = codexServers(valueOf(config), listed && "servers" in listed ? listed.servers : null, displayPath(host.home, configPath));
  const override = join(dir, "AGENTS.override.md");
  const hasOverride = await exists(override);
  const rules = hasOverride
    ? [await ruleFile(host, "AGENTS.override.md", override, "active"), await ruleFile(host, "AGENTS.md", join(dir, "AGENTS.md"), "inactive", "Not read while AGENTS.override.md exists.")]
    : [await ruleFile(host, "AGENTS.md", join(dir, "AGENTS.md"), "active")];
  const disabled = new Set<string>();
  const skillConfig = record(record(valueOf(config))?.skills)?.config;
  for (const entry of Array.isArray(skillConfig) ? skillConfig : []) {
    const item = record(entry);
    const path = text(item?.path);
    if (item?.enabled === false && path) disabled.add(normalize(/^~[\\/]/.test(path) ? join(host.home, path.slice(2)) : resolve(dir, path)));
  }
  const skillFolders = [
    await skillFolder(host, "Skills", join(host.home, ".agents", "skills"), null, disabled),
    await skillFolder(host, "Skills (old location)", join(dir, "skills"), "Deprecated location that Codex still reads.", disabled),
    ...await pluginSkillFolders(host, join(dir, "plugins", "cache"), "Plugin"),
  ];
  return {
    id: "codex", name: "Codex", configPath: displayPath(host.home, configPath),
    found: !("missing" in config) || rules.some(rule => rule.state !== "missing") || skillFolders.some(folder => folder.exists),
    errors, servers: await withHealth(host, drafts), rules, skillFolders,
    toolSearch: codexToolSearch(valueOf(config), valueOf(modelsCache)),
    notes: listed ? [] : ["Codex's command line wasn't found, so plugin servers and sign-in state are missing."],
  };
}

// ---------- OpenCode ----------

export function opencodeServers(config: unknown, auth: unknown, source: string): ServerDraft[] {
  const servers = record(record(config)?.mcp) ?? {};
  const signedIn = record(auth) ?? {};
  return sortByName(Object.entries(servers).map(([name, raw]): ServerDraft => {
    const server = record(raw) ?? {};
    const type = text(server.type);
    const command = Array.isArray(server.command) ? text(server.command[0]) : text(server.command);
    const url = text(server.url);
    const local = type === "local" || (!type && command);
    const stored = record(signedIn[name]);
    return {
      name, transport: local ? "stdio" : type === "remote" || url ? "http" : "unknown",
      enabled: server.enabled !== false, enabledNote: null,
      signIn: local ? "not-needed" : stored?.tokens ? "signed-in" : server.oauth === false ? "not-needed" : "unknown",
      command: local && command ? commandName(command) : null, url: !local && url ? sanitizeUrl(url) : null, source, notes: [],
      check: local && command ? { kind: "command", command } : !local && url ? { kind: "url", url } : null,
    };
  }));
}

async function opencodeInventory(host: InventoryHost): Promise<ToolProviderInventory> {
  const dir = join(text(host.env.XDG_CONFIG_HOME) ?? join(host.home, ".config"), "opencode");
  const dataDir = join(text(host.env.XDG_DATA_HOME) ?? join(host.home, ".local", "share"), "opencode");
  // OpenCode merges these global files in order; later ones win.
  const files = ["config.json", "opencode.json", "opencode.jsonc"].map(name => join(dir, name));
  const loaded = await Promise.all(files.map(path => load(host, path, "jsonc")));
  const auth = await load(host, join(dataDir, "mcp-auth.json"), "json");
  const present = files.filter((_, index) => !("missing" in loaded[index]));
  const mcp: Json = {};
  const instructions: string[] = [];
  for (const entry of loaded) {
    const config = record(valueOf(entry));
    Object.assign(mcp, record(config?.mcp) ?? {});
    for (const item of Array.isArray(config?.instructions) ? config.instructions : []) if (typeof item === "string" && !instructions.includes(item)) instructions.push(item);
  }
  const configPath = present[present.length - 1] ?? join(dir, "opencode.json");
  const source = displayPath(host.home, configPath);
  const drafts = opencodeServers({ mcp }, valueOf(auth), source);
  const agents = join(dir, "AGENTS.md");
  const claudeFallback = join(text(host.env.CLAUDE_CONFIG_DIR) ?? join(host.home, ".claude"), "CLAUDE.md");
  const hasAgents = await exists(agents);
  const claudeOff = TRUTHY.test(host.env.OPENCODE_DISABLE_CLAUDE_CODE ?? "") || TRUTHY.test(host.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT ?? "");
  const rules = [await ruleFile(host, "AGENTS.md", agents, "active")];
  if (!hasAgents) {
    const fallback = await ruleFile(host, "CLAUDE.md (fallback)", claudeFallback, claudeOff ? "inactive" : "active",
      claudeOff ? "Claude Code files are turned off for OpenCode." : "Read because there's no global AGENTS.md.");
    if (fallback.state !== "missing") rules.push(fallback);
  }
  for (const item of instructions) {
    if (/^https?:\/\//i.test(item)) {
      rules.push({ label: "Instruction URL", path: sanitizeUrl(item) ?? "URL", state: "active", note: "OpenCode fetches it; not previewed here.", size: null, preview: null, truncated: false });
      continue;
    }
    const expanded = item.startsWith("~") ? join(host.home, item.slice(1)) : isAbsolute(item) ? item : resolve(dir, item);
    if (/[*?[{]/.test(item)) {
      rules.push({ label: "Instruction pattern", path: displayPath(host.home, expanded), state: "active", note: "A file pattern from instructions; matches aren't listed.", size: null, preview: null, truncated: false });
      continue;
    }
    rules.push(await ruleFile(host, `Instruction: ${basename(expanded)}`, expanded, "active", "From instructions in the config."));
  }
  const skillFolders = [
    await skillFolder(host, "Skills", join(dir, "skills")),
    await skillFolder(host, "Claude Code skills", join(text(host.env.CLAUDE_CONFIG_DIR) ?? join(host.home, ".claude"), "skills"), "OpenCode also reads Claude Code's skills."),
    await skillFolder(host, "Shared skills", join(host.home, ".agents", "skills"), "OpenCode also reads ~/.agents/skills."),
  ];
  return {
    id: "opencode", name: "OpenCode", configPath: source,
    found: present.length > 0 || hasAgents || (await isDirectory(join(dir, "skills"))),
    errors: [...loaded.flatMap(errorOf), ...errorOf(auth)],
    servers: await withHealth(host, drafts), rules, skillFolders,
    toolSearch: {
      verdict: "not-supported",
      reason: "OpenCode has no tool search, so every enabled server's tools load into every agent.",
      howToEnable: "Not available. Workaround: turn a large server's tools off globally with \"tools\": { \"<server>_*\": false } and turn them back on for the agents that need them.",
    },
    notes: [],
  };
}

// ---------- GitHub Copilot CLI ----------

/** One Copilot MCP server entry; `pluginRoot` fills in the ${PLUGIN_ROOT} placeholders a plugin's config may use. */
function copilotServer(name: string, raw: unknown, disabled: ReadonlySet<string>, source: string, pluginRoot: string | null = null): ServerDraft {
  const server = record(raw) ?? {};
  const type = text(server.type);
  const root = (value: string | null) => value && pluginRoot ? value.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot).replaceAll("${PLUGIN_ROOT}", pluginRoot) : value;
  const command = root(text(server.command));
  const url = root(text(server.url));
  const local = type === "local" || type === "stdio" || (!type && command);
  const notes = server.deferTools === false ? ["Always loaded (deferTools: false), so tool search doesn't defer it."] : [];
  return {
    name, transport: local ? "stdio" : type === "sse" ? "sse" : url ? "http" : "unknown",
    enabled: !disabled.has(name), enabledNote: disabled.has(name) ? "Listed in disabledMcpServers." : null,
    signIn: local ? "not-needed" : "unknown",
    command: local && command ? commandName(command) : null, url: !local && url ? sanitizeUrl(url) : null, source, notes,
    check: local && command ? { kind: "command", command } : !local && url ? { kind: "url", url } : null,
  };
}

export type CopilotPlugin = { name: string; marketplace: string; enabled: boolean; path: string };

/** Installed plugins as Copilot lists them: `installedPlugins` in config.json, turned on or off by `enabledPlugins` in settings.json. */
export function copilotPlugins(cliConfig: unknown, settings: unknown, dir: string): CopilotPlugin[] {
  const switches = record(record(settings)?.enabledPlugins) ?? {};
  const installed = record(cliConfig)?.installedPlugins;
  const plugins: CopilotPlugin[] = [];
  for (const raw of Array.isArray(installed) ? installed : []) {
    const entry = record(raw);
    const name = text(entry?.name);
    if (!entry || !name) continue;
    const marketplace = text(entry.marketplace) ?? "";
    const switched = switches[`${name}@${marketplace}`];
    const cache = text(entry.cache_path);
    plugins.push({
      name, marketplace, enabled: typeof switched === "boolean" ? switched : entry.enabled !== false,
      path: cache && isAbsolute(cache) ? cache : join(dir, "installed-plugins", marketplace, name),
    });
  }
  return sortByName(plugins);
}

/** A path from a plugin manifest, or null when it leaves the plugin folder (Copilot refuses those too). */
function insidePlugin(root: string, path: string): string | null {
  const resolved = resolve(root, path.replace(/^\.\//, ""));
  const inside = relative(resolve(root), resolved);
  return inside.startsWith("..") || isAbsolute(inside) ? null : resolved;
}

/** Skill folders a plugin manifest names, each once: `skills` as a path, a list, or { paths, exclusive }; `skills/` by default. */
export function copilotPluginSkillPaths(root: string, manifest: unknown): string[] {
  const seen = new Set<string>();
  return manifestSkillPaths(root, manifest).filter(path => !seen.has(normalize(path)) && seen.add(normalize(path)));
}

function manifestSkillPaths(root: string, manifest: unknown): string[] {
  const skills = record(manifest)?.skills;
  const fallback = join(resolve(root), "skills");
  const inside = (paths: unknown[]) => paths.flatMap(path => typeof path === "string" ? [insidePlugin(root, path)].filter((item): item is string => item !== null) : []);
  if (skills === undefined || skills === null) return [fallback];
  if (typeof skills === "string") return inside([skills]);
  if (Array.isArray(skills)) return inside(skills);
  const form = record(skills);
  if (!form || !Array.isArray(form.paths)) return [];
  return form.exclusive === true ? inside(form.paths) : [fallback, ...inside(form.paths)];
}

/** A plugin's MCP servers: .mcp.json or .github/mcp.json first, else `mcpServers` in its manifest (inline or a file inside the plugin). */
async function copilotPluginServerConfig(host: InventoryHost, root: string, manifest: unknown): Promise<{ servers: Json; errors: string[] }> {
  const errors: string[] = [];
  const servers = (value: unknown) => {
    const config = record(value) ?? {};
    return Object.hasOwn(config, "mcpServers") ? record(config.mcpServers) ?? {} : config;
  };
  for (const file of [".mcp.json", join(".github", "mcp.json")]) {
    const loaded = await load(host, join(root, file), "json");
    if ("value" in loaded) return { servers: servers(loaded.value), errors };
    errors.push(...errorOf(loaded));
  }
  const inline = record(manifest)?.mcpServers;
  if (typeof inline === "string") {
    const path = insidePlugin(root, inline);
    const loaded = path ? await load(host, path, "json") : { missing: true } as Loaded;
    return { servers: servers(valueOf(loaded)), errors: [...errors, ...errorOf(loaded)] };
  }
  return { servers: record(inline) ?? {}, errors };
}

/** The skills and MCP servers of each installed Copilot plugin, read from its folder; nothing is run. */
async function copilotPluginInventory(host: InventoryHost, plugins: CopilotPlugin[], disabled: ReadonlySet<string>) {
  const servers: ServerDraft[] = [];
  const skillFolders: SkillFolderEntry[] = [];
  const errors: string[] = [];
  for (const plugin of plugins) {
    if (!await isDirectory(plugin.path)) continue;
    const id = plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name;
    let manifest: unknown = null;
    for (const folder of [".plugin", ".", join(".github", "plugin"), ".claude-plugin"]) {
      const loaded = await load(host, join(plugin.path, folder, "plugin.json"), "json");
      if ("missing" in loaded) continue;
      errors.push(...errorOf(loaded));
      manifest = valueOf(loaded);
      break;
    }
    const config = await copilotPluginServerConfig(host, plugin.path, manifest);
    errors.push(...config.errors);
    for (const [name, raw] of Object.entries(config.servers)) {
      const server = copilotServer(name, raw, disabled, `Copilot plugin ${id}`, plugin.path);
      servers.push(plugin.enabled ? server : { ...server, enabled: false, enabledNote: `The plugin ${id} is turned off.` });
    }
    const note = plugin.enabled ? `From the Copilot plugin ${id}.` : `From the Copilot plugin ${id}, which is turned off.`;
    const label = `Plugin: ${plugin.marketplace ? `${plugin.marketplace} / ` : ""}${plugin.name}`;
    for (const path of copilotPluginSkillPaths(plugin.path, manifest)) {
      const folder = await skillFolder(host, label, path, note);
      if (folder.skills.length) skillFolders.push({ ...folder, skills: folder.skills.map(skill => ({ ...skill, enabled: plugin.enabled })) });
    }
  }
  return { servers: sortByName(servers), skillFolders, errors };
}

function copilotDisabledServers(settings: unknown[]): Set<string> {
  const disabled = new Set<string>();
  for (const value of settings) {
    const list = record(value)?.disabledMcpServers;
    for (const name of Array.isArray(list) ? list : []) if (typeof name === "string") disabled.add(name);
  }
  return disabled;
}

export function copilotServers(config: unknown, settings: unknown[], signedIn: boolean, source: string): ServerDraft[] {
  const servers = record(record(config)?.mcpServers) ?? {};
  const disabled = copilotDisabledServers(settings);
  const drafts = Object.entries(servers).map(([name, raw]) => copilotServer(name, raw, disabled, source));
  if (!Object.hasOwn(servers, "github-mcp-server")) {
    drafts.push({
      name: "github-mcp-server", transport: "http", enabled: !disabled.has("github-mcp-server"),
      enabledNote: disabled.has("github-mcp-server") ? "Listed in disabledMcpServers." : "Built in. Start Copilot with --disable-builtin-mcps to leave it out.",
      signIn: signedIn ? "signed-in" : "unknown", command: null, url: null, source: "Built in", notes: ["Uses your Copilot GitHub sign-in."],
      check: null, health: { state: "unknown", label: "Built in; not checked" },
    });
  }
  return sortByName(drafts);
}

export function copilotToolSearch(settings: { label: string; value: unknown }[], deferred: string[]): ToolSearchVerdict {
  const how = "Set \"toolSearch\": true in ~/.copilot/settings.json. Copilot's documentation names this key, but copilot help config doesn't list it yet (unverified).";
  const always = deferred.length ? ` Always loaded: ${deferred.join(", ")}.` : "";
  for (const { label, value } of settings) {
    const setting = record(value)?.toolSearch;
    if (setting === true) return { verdict: "on", reason: `toolSearch is true in ${label}.${always}`, howToEnable: "Already on." };
    if (setting === false) return { verdict: "off", reason: `toolSearch is false in ${label}.`, howToEnable: how };
  }
  return { verdict: "unknown", reason: `toolSearch isn't set, so it follows Copilot's default for the model (on for supported Claude models, per the changelog).${always}`, howToEnable: how };
}

async function copilotInventory(host: InventoryHost): Promise<ToolProviderInventory> {
  const dir = join(host.home, ".copilot");
  const configPath = join(dir, "mcp-config.json");
  const [config, settings, cliConfig] = await Promise.all([
    load(host, configPath, "json"), load(host, join(dir, "settings.json"), "jsonc"), load(host, join(dir, "config.json"), "jsonc"),
  ]);
  const settingsFiles = [
    { label: displayPath(host.home, join(dir, "settings.json")), value: valueOf(settings) },
    { label: displayPath(host.home, join(dir, "config.json")), value: valueOf(cliConfig) },
  ];
  const users = record(valueOf(cliConfig))?.loggedInUsers;
  const settingsValues = settingsFiles.map(file => file.value);
  const plugins = await copilotPluginInventory(host, copilotPlugins(valueOf(cliConfig), valueOf(settings), dir), copilotDisabledServers(settingsValues));
  const drafts = sortByName([...copilotServers(valueOf(config), settingsValues, Array.isArray(users) && users.length > 0, displayPath(host.home, configPath)), ...plugins.servers]);
  const rules = [await ruleFile(host, "copilot-instructions.md", join(dir, "copilot-instructions.md"), "active")];
  const instructionsDir = join(dir, "instructions");
  for (const path of await findFiles(instructionsDir, name => name.toLowerCase().endsWith(".instructions.md"))) {
    rules.push(await ruleFile(host, `instructions/${relative(instructionsDir, path).replaceAll("\\", "/")}`, path, "active"));
  }
  const extra = (host.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? "").split(new RegExp(`[,${delimiter === ";" ? ";" : ":"}]`)).map(item => item.trim()).filter(item => isAbsolute(item));
  for (const folder of extra) {
    const files = await findFiles(folder, name => name === "AGENTS.md" || name.toLowerCase().endsWith(".instructions.md"), 3);
    for (const path of files) rules.push(await ruleFile(host, `Custom: ${basename(path)}`, path, "active", "From COPILOT_CUSTOM_INSTRUCTIONS_DIRS."));
  }
  const skillFolders = [
    await skillFolder(host, "Skills", join(dir, "skills")),
    await skillFolder(host, "Shared skills", join(host.home, ".agents", "skills"), "Copilot also reads ~/.agents/skills."),
    ...plugins.skillFolders,
  ];
  return {
    id: "copilot", name: "GitHub Copilot CLI", configPath: displayPath(host.home, configPath),
    found: !("missing" in config) || !("missing" in cliConfig) || rules.some(rule => rule.state !== "missing") || skillFolders[0].exists,
    errors: [...errorOf(config), ...errorOf(settings), ...errorOf(cliConfig), ...plugins.errors],
    servers: await withHealth(host, drafts), rules, skillFolders,
    toolSearch: copilotToolSearch(settingsFiles, drafts.filter(server => server.notes.some(note => note.includes("deferTools"))).map(server => server.name)),
    notes: ["Sign-in state for Copilot's own servers isn't stored in a readable file. Plugin servers and skills are read from the plugin folders listed in ~/.copilot/config.json."],
  };
}

// ---------- host ----------

export async function collectToolsInventory(host: InventoryHost): Promise<ToolsInventory> {
  const providers = await Promise.all([claudeInventory(host), codexInventory(host), opencodeInventory(host), copilotInventory(host)]);
  return { home: host.home, checkedAt: host.now().toISOString(), providers: await describeToggles(host, providers) };
}

function pathEntries(env: Record<string, string | undefined>) {
  const key = Object.keys(env).find(name => name.toLowerCase() === "path");
  return (key ? env[key] ?? "" : "").split(delimiter).map(entry => entry.trim().replace(/^"(.*)"$/, "$1")).filter(entry => isAbsolute(entry));
}

/** The file a bare command name runs, the way the shell finds it; nothing is executed. */
async function resolveCommand(command: string, env: Record<string, string | undefined>, platform: NodeJS.Platform): Promise<string | null> {
  const extensions = platform === "win32" ? [...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ""] : [""];
  const candidates = isAbsolute(command) ? extensions.map(ext => command + ext) : pathEntries(env).flatMap(dir => extensions.map(ext => join(dir, command + ext)));
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return null;
}

function runJson(file: string, args: string[], verbatim: boolean): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: verbatim }, (error, stdout) => {
      // Node's error repeats the command line; report only that it failed.
      if (error) { reject(new Error((error as { killed?: boolean }).killed ? "codex mcp list --json didn't answer within 20 seconds." : "codex mcp list --json failed.")); return; }
      try { resolvePromise(JSON.parse(stdout)); } catch { reject(new Error("codex mcp list --json didn't return JSON.")); }
    });
  });
}

export function localHost(): InventoryHost {
  const env = process.env;
  const platform = process.platform;
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  return {
    home: homedir(), env, platform,
    claudeManagedSettings: platform === "win32" ? join(programFiles, "ClaudeCode", "managed-settings.json")
      : platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json",
    now: () => new Date(),
    async findCommand(command) {
      if (!isAbsolute(command) && /[\\/]/.test(command)) return "unknown";
      if (/[$%]/.test(command)) return "unknown";
      return await resolveCommand(command, env, platform) ? "found" : "missing";
    },
    async probeUrl(url) {
      try {
        // `url` comes from probeAddress: no user info, query or fragment. No configured headers or tokens are sent; the body is discarded.
        const response = await fetch(url, { method: "GET", redirect: "manual", headers: { accept: "application/json, text/event-stream" }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        void response.body?.cancel().catch(() => {});
        const status = response.status;
        if (status === 401 || status === 403) return { state: "warning", label: `Reachable; asks for sign-in (HTTP ${status})` };
        if (status === 404) return { state: "error", label: "Not found (HTTP 404)" };
        if (status >= 500) return { state: "error", label: `Server error (HTTP ${status})` };
        return { state: "ok", label: `Reachable (HTTP ${status})` };
      } catch (error) {
        return { state: "error", label: (error as Error).name === "TimeoutError" ? `No answer within ${PROBE_TIMEOUT_MS / 1000} seconds` : "Unreachable" };
      }
    },
    async codexMcpList() {
      const file = await resolveCommand("codex", env, platform);
      if (!file) return null;
      try {
        if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
          // A .cmd launcher only runs under cmd.exe; the arguments are fixed.
          if (/["%^&|<>]/.test(file)) return { error: "Codex's command path can't be passed to cmd.exe safely, so plugin servers aren't listed." };
          const shell = env.ComSpec && isAbsolute(env.ComSpec) ? env.ComSpec : "C:\\Windows\\System32\\cmd.exe";
          return { servers: await runJson(shell, ["/d", "/s", "/c", `""${file}" mcp list --json"`], true) };
        }
        return { servers: await runJson(file, ["mcp", "list", "--json"], false) };
      } catch (error) {
        return { error: `${(error as Error).message} Plugin servers and sign-in state are missing.` };
      }
    },
  };
}

export function localToggleHost(): ToggleHost {
  const { home, env, now, codexMcpList } = localHost();
  return { home, env, now, codexMcpList, backupDir: defaultBackupDir(env) };
}

/** Settings → Tools & skills reads this host's inventory on demand, and turns servers on or off after confirmation. */
export function registerToolsInventory(server: Pick<PluginServerContext, "handle">, host: () => InventoryHost = localHost, toggleHost: () => ToggleHost = localToggleHost) {
  server.handle(readToolsInventory, () => collectToolsInventory(host()));
  server.handle(planMcpToggle, target => planToggle(toggleHost(), target));
  server.handle(applyMcpToggle, input => applyToggle(toggleHost(), input));
}
