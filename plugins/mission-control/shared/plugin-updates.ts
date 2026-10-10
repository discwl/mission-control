import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Updates to this plugin through Paseo's own `plugin update` flow on the installation host.
// The detached update writes its output to this file in the host's temporary folder.
export const updateLogName = "mission-control-plugin-update.log";

export const pluginSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("directory"), path: z.string() }),
  z.object({ kind: z.literal("git"), remote: z.string(), pluginPath: z.string().nullable() }),
  z.object({ kind: z.literal("npm"), name: z.string().nullable() }),
  z.object({ kind: z.literal("other"), label: z.string() }),
]);
export type PluginSource = z.infer<typeof pluginSourceSchema>;

export const pluginUpdateStatusSchema = z.object({
  /** The version built into the running plugin. */
  version: z.string(),
  source: pluginSourceSchema.nullable(),
  /** update: a newer version exists; current: up to date; installed-newer: ahead of the repository's default branch; local: installed from a folder. */
  state: z.enum(["update", "current", "installed-newer", "local", "error", "unavailable"]),
  current: z.string().nullable(),
  target: z.string().nullable(),
  links: z.array(z.string()).max(10),
  checkedAt: z.string(),
  error: z.string().nullable(),
  /** Paseo is applying an update started from this screen; the other fields are from the check before it. */
  updating: z.boolean(),
  /** Why the last update started here did not replace the plugin. */
  lastUpdateError: z.string().nullable(),
});
export type PluginUpdateStatus = z.infer<typeof pluginUpdateStatusSchema>;

export const checkPluginUpdate = defineRpc({ name: "plugin-updates.check", input: z.object({}), output: pluginUpdateStatusSchema });
// Starts the update in the background once the server confirms `target` is still the reviewed one.
// The plugin reloads during the update, so the client rechecks instead of waiting on this call.
export const applyPluginUpdate = defineRpc({
  name: "plugin-updates.apply",
  input: z.object({ target: z.string().min(1).max(200) }),
  output: z.object({ started: z.literal(true) }),
});
