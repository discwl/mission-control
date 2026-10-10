import { getPaseoClient, useHosts, useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { Pressable, ScrollView, Text, View } from "react-native";
import { getMissionSummary } from "../shared/mission";
import { AgentTree, treeSummaryLine } from "./agent-tree";
import { CompactLink } from "./compact-link";

/**
 * The Agents panel in Explorer: every agent of this workspace as a tree, with sub-agents under their
 * parents, filters, search, and the actions each agent allows.
 */
export function AgentsPanel({ theme, host, workspaceId, navigation, layout }: PluginWorkspacePanelProps) {
  const colors = theme.colors;
  const serverId = host.id;
  const online = useHosts().some(candidate => candidate.serverId === serverId && candidate.status === "online");
  const workspace = useQuery({
    queryKey: ["mission-control", "workspace", serverId, workspaceId],
    queryFn: () => getPaseoClient(serverId).workspaces.ref(workspaceId).refresh(),
    enabled: online, staleTime: 30_000,
  });
  // Tasks, decisions, runs and helpers come from the host this Mission Control runs on; its summary says which that is.
  const readSummary = useRpc(getMissionSummary);
  const summary = useQuery({ queryKey: ["mission-control", "mission-summary", workspaceId], queryFn: () => readSummary({ workspaceIds: [workspaceId] }), enabled: online, staleTime: 60_000, retry: false });
  const localServerId = summary.data?.serverId ?? "";
  // focusHost asks Paseo to switch its sidebar to this host; releases that don't support it ignore it.
  const openAgent = (agentId: string) => { try { const target = { serverId, agentId, focusHost: true }; navigation?.openAgent(target); } catch { /* The chat stays where it is. */ } };
  const title = workspace.data?.title?.trim() || workspace.data?.name || "This workspace";
  return <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 12 : 14, gap: 10 }} keyboardShouldPersistTaps="handled">
    <AgentTree serverId={serverId} localServerId={localServerId} workspaceId={workspaceId} online={online} colors={colors}
      canNavigate={Boolean(navigation) && online} openAgent={openAgent}
      heading={(counts, { refresh, refreshing, renameAll }) => <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: "600", letterSpacing: 0.8 }}>AGENTS</Text>
          <Text accessibilityRole="header" numberOfLines={1} style={{ color: colors.foreground, fontSize: 19, fontWeight: "700" }}>{title}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{treeSummaryLine(counts)}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {renameAll}
          <CompactLink label={refreshing ? "Refreshing…" : "Refresh"} accessibilityLabel="Refresh agents" disabled={refreshing || !online} onPress={refresh} colors={colors} />
        </View>
      </View>} />
  </ScrollView>;
}
