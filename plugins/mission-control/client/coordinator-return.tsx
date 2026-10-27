import { useHosts, type PluginClientContext, type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { z } from "zod";
import { fleetScreenId } from "../shared/fleet";
import { CompactLink } from "./compact-link";
import { readClientStorage, writeClientStorage } from "./web";

const originSchema = z.object({ version: z.literal(1), kind: z.enum(["chat", "fleet"]), serverId: z.string().min(1), agentId: z.string().min(1), workspaceId: z.string(), label: z.string().max(500) });
export type CoordinatorOrigin = z.infer<typeof originSchema>;
export const coordinatorReturnScreenId = "coordinator-return";
const key = "mission-control:coordinator-return:v1";
let fallback: CoordinatorOrigin | null = null;
const pendingReturns = new Set<string>();
let returnSequence = 0;
function queueReturn() {
  const request = `${Date.now()}:${++returnSequence}`;
  pendingReturns.add(request);
  while (pendingReturns.size > 20) pendingReturns.delete(pendingReturns.values().next().value!);
  return request;
}
export function restoreCoordinatorOrigin(value: unknown): CoordinatorOrigin | null {
  const parsed = originSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function readCoordinatorOrigin(): CoordinatorOrigin | null {
  try { const value = readClientStorage(key); return value ? restoreCoordinatorOrigin(JSON.parse(value)) : fallback; }
  catch { return fallback; }
}
/** Only metadata needed to return; navigation never sends a prompt or changes worker state. */
export function rememberCoordinatorOrigin(origin: CoordinatorOrigin) {
  fallback = origin;
  try { writeClientStorage(key, JSON.stringify(origin)); } catch { /* Session fallback remains usable. */ }
}
export function navigateWithCoordinatorReturn(origin: CoordinatorOrigin, navigate: () => void) {
  const previous = readCoordinatorOrigin();
  rememberCoordinatorOrigin(origin);
  try { navigate(); }
  catch (error) {
    fallback = previous;
    try { writeClientStorage(key, previous ? JSON.stringify(previous) : "null"); } catch { /* Keep the session fallback. */ }
    throw error;
  }
}
function ReturnItem({ openScreen }: PluginSidebarItemProps) {
  const [origin, setOrigin] = useState(readCoordinatorOrigin);
  // All connected installations can render this row; browser storage shares the origin between them.
  useEffect(() => { const timer = setInterval(() => setOrigin(readCoordinatorOrigin()), 2000); return () => clearInterval(timer); }, []);
  return origin ? <SidebarRow icon="ArrowLeft" label="Return to orchestrator" onPress={() => openScreen({ screenId: coordinatorReturnScreenId, params: { request: queueReturn() } })} /> : null;
}
export function registerCoordinatorReturn(client: PluginClientContext) {
  function ReturnScreen({ theme, host, navigation, params }: PluginScreenProps) {
    const [origin, setOrigin] = useState(readCoordinatorOrigin);
    const [error, setError] = useState<string | null>(null);
    const hosts = useHosts();
    const online = origin && (origin.serverId === host.id || hosts.some(item => item.serverId === origin.serverId && item.status === "online"));
    const go = () => {
      const destination = readCoordinatorOrigin();
      setOrigin(destination);
      if (!destination) return;
      try {
        const connected = destination.serverId === host.id || hosts.some(item => item.serverId === destination.serverId && item.status === "online");
        if (!connected) throw new Error("The coordinator host is offline. Reconnect it, then retry.");
        if (destination.kind === "fleet" && destination.serverId === host.id) client.openScreen({ screenId: fleetScreenId });
        else {
          if (!navigation) throw new Error("Conversation navigation is unavailable in this client.");
          navigation.openAgent({ serverId: destination.serverId, agentId: destination.agentId });
        }
        setError(null);
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    };
    // A cached screen can remount on a theme or layout change. Only a fresh explicit
    // shortcut click may trigger automatic navigation, and each request is consumed once.
    useEffect(() => { if (params.request && pendingReturns.delete(params.request)) go(); }, [params.request]);
    return <View style={{ flex: 1, padding: 20, gap: 12, backgroundColor: theme.colors.surface0 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 20, fontWeight: "700" }}>Return to orchestrator</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>{origin ? origin.label : "Open a worker from Mission Control to save a return destination."}</Text>
      {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusWarning }}>{error}</Text> : null}
      {origin ? <CompactLink label="Return to orchestrator" colors={theme.colors} disabled={!online} onPress={go} /> : null}
      {origin?.kind === "fleet" && origin.serverId !== host.id ? <Text style={{ color: theme.colors.foregroundMuted }}>This returns to the coordinator chat. Select its host and open Orchestrator to restore the saved console view.</Text> : null}
    </View>;
  }
  const removeScreen = client.addScreen({ id: coordinatorReturnScreenId, title: "Return to orchestrator", Component: ReturnScreen });
  const removeSidebar = client.addSidebarHeaderItem({ id: coordinatorReturnScreenId, title: "Return to orchestrator", Component: ReturnItem });
  const removeCommand = client.addCommandCenterItem({ id: coordinatorReturnScreenId, title: "Return to orchestrator", icon: "ArrowLeft", context: "global", keywords: ["back", "coordinator", "worker"], onSelect: () => client.openScreen({ screenId: coordinatorReturnScreenId, params: { request: queueReturn() } }) });
  return () => { removeCommand(); removeSidebar(); removeScreen(); };
}
