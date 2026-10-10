import { useRpc } from "./host-rpc";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Image, Text } from "react-native";
import { isMarkdownPath, readReviewWorkingFile } from "../shared/review";
import { AppModal } from "./app-modal";
import { MarkdownPreview } from "./markdown-preview";
import { mono, type Colors } from "./review-ui";

export function ReviewFilePreview({ serverId, workspaceId, path, online, colors, compact, onClose }: {
  serverId: string; workspaceId: string; path: string; online: boolean; colors: Colors; compact: boolean; onClose: () => void;
}) {
  const readFile = useRpc(readReviewWorkingFile);
  const [imageError, setImageError] = useState(false);
  const query = useQuery({
    queryKey: ["mission-control", "review-working-preview", serverId, workspaceId, path],
    queryFn: () => readFile({ serverId, workspaceId, path }),
    enabled: online, staleTime: 0, gcTime: 0, retry: false,
  });
  const data = online ? query.data : undefined;
  return <AppModal open onOpenChange={open => { if (!open) onClose(); }} title="File preview" colors={colors} maxWidth={1100}>
    <AppModal.Content contentContainerStyle={{ padding: compact ? 16 : 24, gap: 12 }}>
      <Text selectable style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>{path}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Working file on the selected workspace host. Close to return to Review.</Text>
      {!online ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>Connect to the workspace host to preview this file.</Text> : null}
      {online && query.isPending ? <Text style={{ color: colors.foregroundMuted }}>Loading file…</Text> : null}
      {online && query.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{query.error instanceof Error ? query.error.message : String(query.error)}</Text> : null}
      {data?.truncated ? <Text style={{ color: colors.statusWarning }}>Only the first 512 KB are shown.</Text> : null}
      {data?.image ? imageError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>This image could not be displayed. Reveal it in Explorer to open it with another app.</Text>
        : <Image accessibilityLabel={`Preview of ${path}`} source={{ uri: `data:${data.image.mimeType};base64,${data.image.base64}` }} resizeMode="contain" onError={() => setImageError(true)} style={{ width: "100%", height: compact ? 300 : 520 }} />
        : data ? isMarkdownPath(path) ? <MarkdownPreview content={data.text} colors={colors} />
          : <ScrollView horizontal><Text selectable style={[mono, { color: colors.foreground }]}>{data.text || "This file is empty."}</Text></ScrollView> : null}
    </AppModal.Content>
  </AppModal>;
}
