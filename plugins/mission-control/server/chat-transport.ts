import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createHostChannelTransport } from "@getpaseo/client/internal/hosts";
import { randomUUID } from "node:crypto";
import { withFleetConnection } from "./fleet-transport";

/** Call only an already registered host. link=false keeps Personal off remote host lists. */
export function invokeChatHost(serverId: string, method: string, input: unknown): Promise<unknown> {
  return withFleetConnection(async (_paseo, origin, local) => {
    if (serverId === local) return origin.invokePluginRpc("mission-control", method, input);
    origin.requireConnectedHosts();
    const scopeId = `mc-chat-${randomUUID()}`;
    const client = new DaemonClient({ url: "ws://routed-host/ws", clientId: scopeId, clientType: "cli", connectTimeoutMs: 8000,
      transportFactory: createHostChannelTransport(origin, serverId, scopeId, null, false), reconnect: { enabled: false } });
    try {
      await client.connect();
      if (client.getLastServerInfoMessage()?.serverId !== serverId) throw new Error("Remote host identity mismatch.");
      return await client.invokePluginRpc("mission-control", method, input);
    } finally { await client.close(); }
  });
}
