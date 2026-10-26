import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createHostChannelTransport } from "@getpaseo/client/internal/hosts";
import { randomUUID } from "node:crypto";
import { fleetHostSchema, readFleetHost, type FleetHost } from "../shared/fleet";
import { daemonServerId, daemonWsUrl } from "./agent-names";
import { readCompatibleFleet, type FleetScope } from "./fleet-compat";

/** Internal 0.13.2 transport adapter. Only uses routes already registered on this daemon. */
export async function withFleetConnection<T>(action: (paseo: PaseoApi, client: DaemonClient, serverId: string) => Promise<T>): Promise<T> {
  const serverId = await daemonServerId();
  const client = new DaemonClient({ url: await daemonWsUrl(), clientId: `mc-fleet-${randomUUID()}`, clientType: "cli", connectTimeoutMs: 5000, reconnect: { enabled: false } });
  const paseo = createPaseoApi(client);
  try {
    await client.connect();
    if (client.getLastServerInfoMessage()?.serverId !== serverId) throw new Error("Orchestrator connected to a different local daemon.");
    return await action(paseo, client, serverId);
  } finally { paseo.dispose(); await client.close(); }
}

export async function readRemoteFleet(origin: DaemonClient, serverId: string, scope?: FleetScope): Promise<FleetHost> {
  origin.requireConnectedHosts();
  const scopeId = `mc-fleet-${randomUUID()}`;
  const client = new DaemonClient({ url: "ws://routed-host/ws", clientId: scopeId, clientType: "cli", connectTimeoutMs: 8000,
    transportFactory: createHostChannelTransport(origin, serverId, scopeId, null), reconnect: { enabled: false } });
  const paseo = createPaseoApi(client);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.connect();
        if (client.getLastServerInfoMessage()?.serverId !== serverId) throw new Error("Remote host identity mismatch.");
        let payload: unknown;
        try { payload = await client.invokePluginRpc("mission-control", readFleetHost.name, { serverId }); }
        catch (error) {
          if (!scope || !/unknown.*(rpc|method)|(?:rpc|method).*not.*found|not.*registered|no.*handler|handler_not_found/i.test(error instanceof Error ? error.message : String(error))) throw error;
          return readCompatibleFleet(paseo, client, serverId, scope);
        }
        const result = fleetHostSchema.parse(payload);
        if (result.serverId !== serverId) throw new Error("Mission Control returned another host's records.");
        return result;
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Host did not respond within 18 seconds. Update Mission Control on that host if its fleet endpoint is unavailable.")), 18_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); paseo.dispose(); await client.close(); }
}
