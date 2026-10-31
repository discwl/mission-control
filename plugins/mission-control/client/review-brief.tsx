import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView, Text, View } from "react-native";
import type { FleetTask } from "../shared/fleet";
import type { ReviewSnapshot } from "../shared/review";
import { CompactLink } from "./compact-link";
import { usePageState } from "./page-state";
import { pageKey } from "./page-memory";
import { reviewBrief } from "./review-brief-model";
import { formatDateTime } from "./date-time";

export function ReviewBrief({ entry, serverId, workspaceId, snapshot, stale, colors, selectFile, onEvidence }: { entry: FleetTask; serverId: string; workspaceId: string; snapshot: ReviewSnapshot | null; stale: boolean; colors: PluginSurfaceProps["theme"]["colors"]; selectFile(path: string): void; onEvidence(): void }) {
  const [expanded, setExpanded] = usePageState(pageKey("review-brief", serverId, workspaceId, entry.task.taskId), false);
  const brief = reviewBrief(entry, serverId, workspaceId, snapshot, stale);
  return <View style={{ padding: 10, gap: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
    <CompactLink label={`Review brief · ${expanded ? "Hide" : "Read before reviewing"}`} expanded={expanded} colors={colors} onPress={() => setExpanded(!expanded)} />
    {!expanded ? <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: 12 }}>{brief.summary ?? "A plain-language change summary has not been supplied for this run."}</Text> : <View style={{ gap: 12 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{brief.warning}{brief.requestedAt ? ` Requested ${formatDateTime(brief.requestedAt)}.` : ""}</Text>
      {[["Intended outcome", brief.outcome], ["What the agent changed", brief.summary ?? "No plain-language change summary supplied."], ["What the review found", brief.found ?? "No plain-language review result supplied."], ["Remaining concerns", brief.remaining], ...(brief.problem ? [["Task issue", brief.problem]] : [])].map(([label, text]) => <View key={label} style={{ gap: 3 }}><Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 13 }}>{label}</Text><Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{text}</Text></View>)}
      <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 13 }}>Where to start in the diff</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Files with unresolved findings first, then risk rating. This is a navigation aid, not a review verdict.</Text>
      {!brief.files.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No changed files in the loaded snapshot.</Text> : brief.files.map(file => <CompactLink key={file.path} label={`${file.path} · ${file.severity}`} colors={colors} onPress={() => { selectFile(file.path); setExpanded(false); }} />)}
      {brief.totalFiles > brief.files.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{brief.totalFiles - brief.files.length} more files in the file list.</Text> : null}
      <CompactLink label="Inspect review evidence" colors={colors} onPress={onEvidence} />
    </View>}
  </View>;
}
