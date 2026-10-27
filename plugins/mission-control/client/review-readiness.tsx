import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { usePageState } from "./page-state";
import { pageKey } from "./page-memory";
import { Text, View } from "react-native";
import type { FleetTask } from "../shared/fleet";
import type { ReviewSnapshot } from "../shared/review";
import { listTaskDocuments } from "../shared/tasks";
import { listTaskRuns } from "../shared/runs";
import { useRpc } from "./host-rpc";
import { CompactLink } from "./compact-link";
import { recentActivity } from "./task-flow-model";
import { resolveEvidence } from "./task-flow-presentation";
import { reviewReadiness } from "./review-readiness-model";

type Colors = PluginSurfaceProps["theme"]["colors"];
export function ReviewReadiness({ entry, serverId, workspaceId, online, snapshot, stale, complete, colors, onEvidence, onDecision }: {
  entry: FleetTask; serverId: string; workspaceId: string; online: boolean; snapshot: ReviewSnapshot | null; stale: boolean; complete: boolean; colors: Colors;
  onEvidence: (document?: string) => void; onDecision: () => void;
}) {
  const [expanded, setExpanded] = usePageState(pageKey("review-checklist", serverId, workspaceId, entry.task.taskId), false);
  const read = useRpc(listTaskDocuments);
  const binding = { serverId, workspaceId, taskId: entry.task.taskId };
  const documents = useQuery({ queryKey: ["mission-control", "flow-documents", serverId, workspaceId, entry.task.taskId], queryFn: () => read(binding), enabled: online, staleTime: 10_000, refetchInterval: online ? 15_000 : false, retry: false });
  const readRuns = useRpc(listTaskRuns);
  const runs = useQuery({ queryKey: ["mission-control", "runs", serverId, workspaceId, entry.task.taskId], queryFn: () => readRuns(binding), enabled: online, staleTime: 10_000, refetchInterval: online ? 15_000 : false, retry: false });
  const activity = recentActivity(documents.data?.documents ?? [], entry.task.taskId);
  const runById = new Map((runs.data?.runs ?? []).map(run => [run.runId, run]));
  const scopedEvents = activity.events.filter(event => {
    const run = runById.get(event.runId);
    return run?.taskId === entry.task.taskId && run.serverId === serverId && run.workspaceId === workspaceId
      && (!event.serverId || event.serverId === serverId) && (!event.workspaceId || event.workspaceId === workspaceId);
  });
  const unscoped = activity.events.filter(event => !runById.has(event.runId)).length;
  const unavailable = !online || documents.isError || documents.isPending || runs.isError || runs.isPending;
  const scopedEntry = { ...entry, decisions: entry.decisions.filter(item => item.decision.serverId === serverId && item.decision.workspaceId === workspaceId) };
  const items = reviewReadiness(scopedEntry, snapshot, scopedEvents, unavailable || unscoped > 0, stale);
  const attention = items.filter(item => !["available", "recorded"].includes(item.status)).length;
  function open(document?: string) {
    const reference = document ? resolveEvidence(document, documents.data?.documents ?? [], entry.task.taskId) : null;
    onEvidence(reference?.kind === "document" ? reference.document.name : undefined);
  }
  return <View style={{ gap: 7, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 7, backgroundColor: colors.surface1 }}>
    <CompactLink label={`Review checklist · ${attention} need attention`} expanded={expanded} colors={colors} onPress={() => setExpanded(!expanded)} />
    <Text selectable style={{ color: stale ? colors.statusWarning : colors.foregroundMuted, fontSize: 11 }}>{snapshot?.head ? `Commit ${snapshot.head.slice(0, 8)}` : "Revision unavailable"}{snapshot ? ` · snapshot ${snapshot.fingerprint.slice(0, 8)}` : ""}{stale ? " · out of date" : ""}</Text>
    {expanded ? <>
      {documents.isPending && online ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Loading recorded evidence…</Text> : null}
      {runs.isError ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Run identities unavailable: {String(runs.error)}</Text> : null}
      {documents.isError ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Evidence unavailable: {String(documents.error)}</Text> : null}
      {!complete ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>This host has limited data. Review decisions and findings may be incomplete.</Text> : null}
      {items.map(item => <View key={item.id} style={{ gap: 5, paddingVertical: 7, borderTopWidth: 1, borderTopColor: colors.border }}>
        <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>{item.label} · <Text style={{ color: ["available", "recorded"].includes(item.status) ? colors.foregroundMuted : colors.statusWarning }}>{item.status}</Text></Text>
        <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{item.detail}</Text>
        {item.document ? <CompactLink label={`Read ${item.label.toLowerCase()} evidence`} colors={colors} onPress={() => open(item.document)} /> : null}
      </View>)}
      {unscoped ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{unscoped} recent records could not be matched to this host and workspace; their results are not used here.</Text> : null}
      {activity.issues.length ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{activity.issues.length} malformed or ambiguous evidence records were excluded.</Text> : null}
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Recent recorded evidence only. Read the results before accepting work; delivery is approved separately.</Text>
      <CompactLink label="All task evidence" colors={colors} onPress={() => onEvidence()} />
      {entry.decisions.some(item => item.decision.kind === "review" && item.decision.status === "open") ? <CompactLink label="Review decision" colors={colors} onPress={onDecision} /> : null}
    </> : null}
  </View>;
}
