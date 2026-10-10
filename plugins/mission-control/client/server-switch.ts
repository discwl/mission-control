import type { McpServerEntry, McpToggleTarget, ToolProviderId } from "../shared/tools-inventory";

/** A server row with a Turn off or Turn on button. */
export function isSwitchable(provider: ToolProviderId, server: Pick<McpServerEntry, "toggle">) {
  return provider !== "claude" && !!server.toggle && !server.toggle.readOnly && server.toggle.enabled !== null;
}

/**
 * Where a change's confirmation, result or error goes in a provider's server list: under the row that was clicked,
 * so it opens where the user is looking. Returns the index of that row, -1 for the top of the section when the
 * server is no longer listed as switchable, or null when the change belongs to another provider.
 */
export function switchAnchor(provider: ToolProviderId, servers: Pick<McpServerEntry, "name" | "toggle">[], target: McpToggleTarget | null | undefined): number | null {
  if (!target || target.provider !== provider) return null;
  return servers.findIndex(server => server.name === target.server && isSwitchable(provider, server));
}
