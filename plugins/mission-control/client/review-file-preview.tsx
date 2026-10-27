import { useRpc } from "./host-rpc";
import { ScrollView, copyText } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Image, Text, View } from "react-native";
import { CompactLink } from "./compact-link";
import { isMarkdownPath, readReviewWorkingFile, resolveReviewItemPath } from "../shared/review";
import { AppModal } from "./app-modal";
import { MarkdownPreview } from "./markdown-preview";
import { mono, type Colors } from "./review-ui";

export function ReviewFilePreview({ serverId, workspaceId, path, online, colors, compact, onClose, embedded = false, openWorkspace }: {
  serverId: string; workspaceId: string; path: string; online: boolean; colors: Colors; compact: boolean; onClose: () => void; embedded?: boolean; openWorkspace?: () => void;
}) {
  const readFile = useRpc(readReviewWorkingFile);
  const [imageError, setImageError] = useState(false);
  const resolvePath = useRpc(resolveReviewItemPath);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  async function copyPath(full: boolean) {
    try {
      const value = full ? (await resolvePath({ serverId, workspaceId, path, directory: false })).path : path;
      if (!active.current) return;
      await copyText(value);
      if (active.current) setCopyStatus(full ? "Full host path copied" : "Relative path copied");
    } catch (error) { if (active.current) setCopyStatus(`Could not copy: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const query = useQuery({
    queryKey: ["mission-control", "review-working-preview", serverId, workspaceId, path],
    queryFn: () => readFile({ serverId, workspaceId, path }),
    enabled: online, staleTime: 0, gcTime: 0, retry: false,
  });
  const data = online ? query.data : undefined;
  const content = <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {!embedded ? <CompactLink label="Back to review" colors={colors} onPress={onClose} /> : null}
        {openWorkspace ? <CompactLink label="Open workspace" colors={colors} disabled={!online} onPress={openWorkspace} /> : null}
        <CompactLink label="Copy relative path" colors={colors} onPress={() => void copyPath(false)} />
        <CompactLink label="Copy full host path" colors={colors} disabled={!online} onPress={() => void copyPath(true)} />
      </View>
      {copyStatus ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 12 }}>{copyStatus}</Text> : null}
      {embedded ? <CompactLink label="Refresh file" colors={colors} disabled={!online || query.isFetching} onPress={() => void query.refetch()} /> : null}
      <Text selectable style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>{path}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Read-only view of the current file on its workspace host. To edit, open the workspace and select this path in Files. Your diff and unfinished review comments stay in Review.</Text>
      {!online ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>Connect to the workspace host to preview this file.</Text> : null}
      {online && query.isPending ? <Text style={{ color: colors.foregroundMuted }}>Loading file…</Text> : null}
      {online && query.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{query.error instanceof Error ? query.error.message : String(query.error)}</Text> : null}
      {data?.truncated ? <Text style={{ color: colors.statusWarning }}>Only the first 512 KB are shown.</Text> : null}
      {data?.image ? imageError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>This image could not be displayed. Reveal it in Explorer to open it with another app.</Text>
        : <Image accessibilityLabel={`Preview of ${path}`} source={{ uri: `data:${data.image.mimeType};base64,${data.image.base64}` }} resizeMode="contain" onError={() => setImageError(true)} style={{ width: "100%", height: compact ? 300 : 520 }} />
        : data ? isMarkdownPath(path) ? <MarkdownPreview content={data.text} colors={colors} />
          : <ScrollView horizontal><Text selectable style={[mono, { color: colors.foreground }]}>{data.text || "This file is empty."}</Text></ScrollView> : null}
    </View>;
  if (embedded) return <ScrollView contentContainerStyle={{ padding: compact ? 16 : 24 }}>{content}</ScrollView>;
  return <AppModal open onOpenChange={open => { if (!open) onClose(); }} title="Current file · read-only" colors={colors} maxWidth={1100}>
    <AppModal.Content contentContainerStyle={{ padding: compact ? 16 : 24, gap: 12 }}>{content}</AppModal.Content>
  </AppModal>;
}
