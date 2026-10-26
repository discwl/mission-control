import { useHosts, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { HostRpcProvider, useMissionControlCopy } from "./host-rpc";
import { ReviewFilePreview } from "./review-file-preview";
import { pluginClient } from "./plugin-client";

export const reviewFileScreenId = "review-file";
export function openReviewFile(serverId: string, workspaceId: string, path: string) {
  const client = pluginClient();
  if (!client) throw new Error("Mission Control is reloading. Try again.");
  client.openScreen({ screenId: reviewFileScreenId, params: { serverId, workspaceId, path } });
}

// Route parameters keep the exact remote identity across reload/back/forward. File reads
// go through the matching host's copy, never through the selected screen host by accident.
export function ReviewFileScreen({ params, theme, layout }: PluginScreenProps) {
  const { serverId = "", workspaceId = "", path = "" } = params;
  const remote = useHosts().find(host => host.serverId === serverId);
  const bridge = useMissionControlCopy(serverId);
  const colors = theme.colors;
  if (!serverId || !workspaceId || !path) return <Text style={{ color: colors.statusDanger }}>This file link is incomplete. Open the file from Review again.</Text>;
  if (!("copy" in bridge)) return <Text style={{ color: colors.statusWarning }}>Connect to the file's host and enable Mission Control there to open this file.</Text>;
  return <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
    <Text style={{ color: colors.foregroundMuted, padding: 12 }}>{remote?.label ?? serverId} · {workspaceId}</Text>
    <HostRpcProvider copy={bridge.copy}><ReviewFilePreview key={JSON.stringify([serverId, workspaceId, path])} serverId={serverId} workspaceId={workspaceId} path={path} online={remote?.status === "online"} colors={colors} compact={layout.compact} embedded onClose={() => {}} /></HostRpcProvider>
  </View>;
}
