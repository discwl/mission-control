import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// A view of each coding agent's global MCP servers, rule files and skills on the plugin's host. The only change it
// makes is turning a server on or off in Codex, OpenCode or Copilot CLI. Nothing here carries secrets: no environment values, headers, tokens, command arguments or URL credentials.

export const toolProviderIds = ["claude", "codex", "opencode", "copilot"] as const;
export type ToolProviderId = typeof toolProviderIds[number];

/** Whether Mission Control can turn a server on or off, and where the switch is. Absent for Claude Code. */
export const mcpToggleSchema = z.object({
  /** The state of the switch in the file, or null when the server is read-only here. */
  enabled: z.boolean().nullable(),
  file: z.string().nullable(),
  /** The exact key that changes, for example `[mcp_servers.gortex] enabled`. */
  key: z.string().nullable(),
  /** Why the server can't be turned on or off here; null when it can. */
  readOnly: z.string().nullable(),
});
export type McpToggle = z.infer<typeof mcpToggleSchema>;

export const mcpServerSchema = z.object({
  name: z.string(),
  transport: z.enum(["stdio", "http", "sse", "unknown"]),
  /** null when the provider has no enabled flag for this server. */
  enabled: z.boolean().nullable(),
  enabledNote: z.string().nullable(),
  signIn: z.enum(["signed-in", "needs-sign-in", "not-needed", "unknown"]),
  /** A light check: stdio servers are never started, remote servers get one unauthenticated request. */
  health: z.object({ state: z.enum(["ok", "warning", "error", "unknown"]), label: z.string() }),
  /** The command's file name only, never its arguments. */
  command: z.string().nullable(),
  /** Scheme, host and path only; user info, query, fragment and key-like path segments are removed. */
  url: z.string().nullable(),
  source: z.string(),
  notes: z.array(z.string()),
  toggle: mcpToggleSchema.optional(),
});
export type McpServerEntry = z.infer<typeof mcpServerSchema>;

export const ruleFileSchema = z.object({
  label: z.string(),
  path: z.string(),
  /** active: the provider reads it; missing: it would, but the file doesn't exist; inactive: present but not read. */
  state: z.enum(["active", "missing", "inactive"]),
  note: z.string().nullable(),
  size: z.number().nullable(),
  preview: z.string().nullable(),
  truncated: z.boolean(),
});
export type RuleFileEntry = z.infer<typeof ruleFileSchema>;

/** `enabled` is false only where the provider's config turns the skill off (Codex's skills.config). */
export const skillSchema = z.object({ name: z.string(), description: z.string(), path: z.string(), enabled: z.boolean() });
export type SkillEntry = z.infer<typeof skillSchema>;

export const skillFolderSchema = z.object({
  label: z.string(),
  path: z.string(),
  exists: z.boolean(),
  note: z.string().nullable(),
  skills: z.array(skillSchema),
});
export type SkillFolderEntry = z.infer<typeof skillFolderSchema>;

export const toolSearchSchema = z.object({
  verdict: z.enum(["on", "off", "not-supported", "unknown"]),
  reason: z.string(),
  howToEnable: z.string(),
});
export type ToolSearchVerdict = z.infer<typeof toolSearchSchema>;

export const toolProviderSchema = z.object({
  id: z.enum(toolProviderIds),
  name: z.string(),
  /** Whether any of the provider's global files were found on this host. */
  found: z.boolean(),
  configPath: z.string(),
  /** Why the provider's config, or part of it, couldn't be read. Line and column only, never file text. */
  errors: z.array(z.string()),
  servers: z.array(mcpServerSchema),
  rules: z.array(ruleFileSchema),
  skillFolders: z.array(skillFolderSchema),
  toolSearch: toolSearchSchema,
  notes: z.array(z.string()),
});
export type ToolProviderInventory = z.infer<typeof toolProviderSchema>;

export const toolsInventorySchema = z.object({
  home: z.string(),
  checkedAt: z.string(),
  providers: z.array(toolProviderSchema),
});
export type ToolsInventory = z.infer<typeof toolsInventorySchema>;

export const readToolsInventory = defineRpc({ name: "tools-inventory.read", input: z.object({}), output: toolsInventorySchema });

// ---------- turning servers on and off ----------

export const toggleProviderIds = ["codex", "opencode", "copilot"] as const;

/**
 * The switch a change sets. true or false writes that value; null removes the key, which only Undo asks for
 * when the change it reverses added the key. For Copilot, false adds the name to disabledMcpServers and true removes it.
 */
export const mcpToggleTargetSchema = z.object({
  provider: z.enum(toggleProviderIds),
  server: z.string().min(1).max(200),
  enabled: z.boolean().nullable(),
});
export type McpToggleTarget = z.infer<typeof mcpToggleTargetSchema>;

/** What a change would do, shown for confirmation. Values only; never other text from the file. */
export const mcpTogglePlanSchema = z.object({
  target: mcpToggleTargetSchema,
  file: z.string(),
  key: z.string(),
  before: z.string(),
  after: z.string(),
  /** Already in the requested state; applying writes nothing. */
  unchanged: z.boolean(),
  /** SHA-256 of the file as read, or "missing". Apply refuses if the file no longer matches. */
  fingerprint: z.string(),
});
export type McpTogglePlan = z.infer<typeof mcpTogglePlanSchema>;

export const mcpToggleResultSchema = z.object({
  target: mcpToggleTargetSchema,
  file: z.string(),
  key: z.string(),
  before: z.string(),
  after: z.string(),
  changed: z.boolean(),
  /** Where the original was copied before the write, or null when nothing was written or the file was new. */
  backup: z.string().nullable(),
  checks: z.array(z.string()),
  /** The change that puts the key back as it was. */
  undo: mcpToggleTargetSchema,
});
export type McpToggleResult = z.infer<typeof mcpToggleResultSchema>;

export const planMcpToggle = defineRpc({ name: "tools-inventory.plan-toggle", input: mcpToggleTargetSchema, output: mcpTogglePlanSchema });
export const applyMcpToggle = defineRpc({
  name: "tools-inventory.apply-toggle",
  input: mcpToggleTargetSchema.extend({ fingerprint: z.string() }),
  output: mcpToggleResultSchema,
});
