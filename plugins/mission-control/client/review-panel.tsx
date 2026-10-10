import { getPaseoClient, useHosts, type PluginAgentPanelProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { MissionReview } from "./mission-review";

// Below this width the file list and diff are stacked instead of side by side.
const sideBySideWidth = 900;

/** Shared Review body; its host supplies scrolling and presentation. */
export function WorkspaceReviewContent(props: (PluginWorkspacePanelProps | PluginAgentPanelProps) & { compact: boolean }) {
  const { theme, host, workspaceId, compact } = props;
  const colors = theme.colors;
  const online = useHosts().some(candidate => candidate.serverId === host.id && candidate.status === "online");
  const workspace = useQuery({
    queryKey: ["mission-control", "workspace", host.id, workspaceId],
    queryFn: () => getPaseoClient(host.id).workspaces.ref(workspaceId).refresh(),
    enabled: online, staleTime: 30_000,
  });
  const data = workspace.data;
  const review = <MissionReview key={`${host.id}:${workspaceId}:${props.context === "agent" ? props.agentId : "workspace"}`} serverId={host.id} online={online} colors={colors} compact={compact} agentId={props.context === "agent" ? props.agentId : undefined}
    workspace={{ id: workspaceId, name: data?.title || data?.name || "Workspace", projectName: data?.projectCustomName || data?.projectDisplayName || "", hostLabel: host.label }} />;
  const error = workspace.isError ? <Text style={{ color: colors.statusDanger }}>Workspace unavailable: {workspace.error instanceof Error ? workspace.error.message : String(workspace.error)}</Text> : null;
  return <>{error}{review}</>;
}

/** The Review panel opened from /review or the panel list. */
export function WorkspaceReview(props: PluginWorkspacePanelProps | PluginAgentPanelProps) {
  const [width, setWidth] = useState(0);
  const colors = props.theme.colors;
  const compact = props.layout.compact || (width > 0 && width < sideBySideWidth);
  const content = <WorkspaceReviewContent {...props} compact={compact} />;
  return <View style={{ flex: 1, backgroundColor: colors.surface0 }} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    {compact
      ? <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 10 }} keyboardShouldPersistTaps="handled">{content}</ScrollView>
      : <View style={{ flex: 1, minHeight: 0, padding: 16, gap: 10 }}>{content}</View>}
  </View>;
}
