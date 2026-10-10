import type { PluginClientContext } from "@getpaseo/plugin/client";

// Panels only receive host props, not the client context. Keep the context from
// registration so a panel can open another panel or Mission Control itself.
let current: PluginClientContext | null = null;

export function setPluginClient(client: PluginClientContext | null) { current = client; }
export function pluginClient() { return current; }
