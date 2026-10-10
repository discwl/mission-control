import { getPaseoClient, type PluginHostSummary, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { ArchiveButton } from "./archive-button";

type Colors = PluginSurfaceProps["theme"]["colors"];

export function WorkspaceTerminals({ host, workspaceId, colors, compact }: { host: PluginHostSummary; workspaceId: string; colors: Colors; compact: boolean }) {
  const online = host.status === "online";
  const query = useQuery({
    queryKey: ["mission-control", "terminals", host.serverId, workspaceId],
    queryFn: () => getPaseoClient(host.serverId).terminals.list({ workspaceId }),
    enabled: online,
    staleTime: 10_000,
    refetchInterval: online ? 20_000 : false,
    retry: false,
  });
  // Paseo lists only live terminals, so an empty or missing list means none are running.
  const terminals = query.data?.entries ?? [];
  if (terminals.length === 0) return null;
  return <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10, gap: 7 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
      <Icon name="Terminal" size={15} color={colors.foregroundMuted} />
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600", flex: 1 }}>Terminals ({terminals.length})</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Refresh workspace terminals" disabled={!online || query.isFetching} onPress={() => void query.refetch()} style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}><Icon name="RefreshCw" size={14} color={colors.foregroundMuted} /></Pressable>
    </View>
    {!online ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Reconnect this host to manage terminals.</Text> : null}
    {query.isError ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Terminals unavailable: {query.error instanceof Error ? query.error.message : String(query.error)}</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      {terminals.map(terminal => <View key={terminal.id} style={[{ borderWidth: 1, borderColor: colors.border, borderRadius: 7, padding: 9, gap: 4 }, compact ? { width: "100%" } : { flexBasis: 300, flexGrow: 1, maxWidth: 480 }]}>
        <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 13 }}>{terminal.name || "Terminal"}</Text>
        <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: 11 }}>{terminal.cwd}</Text>
        <ArchiveButton resource={{ kind: "terminal", id: terminal.id, name: terminal.name || "Terminal", serverId: host.serverId, hostLabel: host.label, workspaceId }} colors={colors} disabled={!online} />
      </View>)}
    </View>
  </View>;
}
