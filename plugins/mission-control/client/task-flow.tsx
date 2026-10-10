import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { listTaskRuns, type RunRecord } from "../shared/runs";
import { listTaskDocuments, type TaskRecord } from "../shared/tasks";
import { CompactLink } from "./compact-link";
import { CopyTaskId } from "./copy-task-id";
import { DecisionCard } from "./decision-card";
import { formatDateTime } from "./date-time";
import { useDecisions } from "./needs-you";
import { activityTitle, artifactLabel, resolveEvidence } from "./task-flow-presentation";
import { ActivityEntry, ArtifactCard, EvidenceList, TaskActivityPreview, TaskAgents } from "./task-flow-content";
import { missingRunIssues, recentActivity, recordedOutcome, type FlowDocument } from "./task-flow-model";

type Colors = PluginSurfaceProps["theme"]["colors"];
type Binding = { serverId: string; workspaceId: string; taskId: string };
const plain = (value: string) => value.replaceAll("_", " ");
const outcomeColor = (outcome: string, colors: Colors) => outcome === "blocked" || outcome === "waiting" ? colors.statusWarning : outcome === "in_progress" ? colors.accent : colors.foregroundMuted;
export function useTaskFlowRuns(binding: Binding, online: boolean) {
  const read = useRpc(listTaskRuns);
  return useQuery({ queryKey: ["mission-control", "runs", binding.serverId, binding.workspaceId, binding.taskId], queryFn: () => read(binding), enabled: online, staleTime: 10_000, refetchInterval: online ? 15_000 : false, retry: false });
}
export function TaskFlowSummary({ task, run, colors, loading = false, error, liveCount = 0 }: { task: TaskRecord; run?: RunRecord; colors: Colors; loading?: boolean; error?: string; liveCount?: number }) {
  const statusLabel = plain(task.status).replace(/^./, letter => letter.toUpperCase());
  const statusColor = task.status === "blocked" ? colors.statusWarning : colors.accent;
  return <View style={{ gap: 12 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
      <View style={{ borderWidth: 1, borderColor: statusColor, borderRadius: 6, paddingHorizontal: 9, paddingVertical: 5, backgroundColor: colors.surface2 }}>
        <Text accessibilityLabel={`Task status: ${statusLabel}`} style={{ color: statusColor, fontSize: 12, fontWeight: "600" }}>{statusLabel}</Text>
      </View>
      {run ? <Text style={{ color: outcomeColor(run.outcome, colors), fontSize: 12 }}>Latest update · {activityTitle(run)}</Text> : null}
      {liveCount > 0 ? <Text style={{ color: colors.accent, fontSize: 12 }}>{liveCount} linked agent{liveCount === 1 ? "" : "s"} running</Text> : null}
    </View>
    {loading && !run ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Loading current run…</Text> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning, fontSize: 12 }}>Run unavailable: {error}</Text> : null}
    {!run && !loading && !error ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No run recorded.</Text> : null}
    {run ? <View style={{ gap: 5, borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: 12, paddingVertical: 3 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>Next action</Text>
      <Text selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 20 }}>{run.nextAction.trim() || "No next action recorded."}</Text>
    </View> : null}
    <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Updated {formatDateTime(run?.updatedAt ?? task.updatedAt)}</Text>
  </View>;
}
export function TaskFlowRow({ task, binding, online, colors, selected, onPress, liveCount = 0 }: { task: TaskRecord; binding: Binding; online: boolean; colors: Colors; selected: boolean; onPress: () => void; liveCount?: number }) {
  const runs = useTaskFlowRuns(binding, online);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const inProgress = runs.data?.runs.some(run => run.outcome === "in_progress") ?? false;
  return <View style={{ gap: 6 }}><Pressable accessibilityRole="button" accessibilityLabel={`Activity for ${task.title}`} accessibilityState={{ selected, expanded }} onPress={() => setExpanded(!expanded)}
    onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={({ pressed }) => ({ padding: 10, minHeight: 44, gap: 7, borderWidth: 1, borderRadius: 7, borderColor: focused || selected || inProgress ? colors.accent : colors.border, backgroundColor: hovered || pressed || selected ? colors.surface2 : colors.surface0 })}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 7 }}>
      <Icon name={inProgress ? "CirclePlay" : "ClipboardList"} size={14} color={inProgress ? colors.accent : colors.foregroundMuted} />
      <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600", flex: 1 }}>{task.title}</Text>
      <CopyTaskId taskId={task.taskId} colors={colors} />
      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} />
    </View>
    <TaskFlowSummary task={task} run={runs.data?.runs[0]} colors={colors} loading={online && runs.isPending} error={runs.isError ? String(runs.error) : !online ? "Host is offline; current run cannot be refreshed." : undefined} liveCount={online ? liveCount : 0} />
    {inProgress ? <Text style={{ color: colors.accent, fontSize: 11 }}>Recorded run in progress</Text> : null}
  </Pressable>
    {expanded ? <TaskActivityPreview binding={binding} online={online} colors={colors} /> : null}
    <CompactLink label="View full details" accessibilityLabel={`View full details for ${task.title}`} icon="ArrowUpRight" colors={colors} onPress={onPress} />
  </View>;
}
export function TaskFlowDetail({ task, binding, online, colors, hostLabel, openAgent }: { task: TaskRecord; binding: Binding; online: boolean; colors: Colors; hostLabel: string; openAgent: (id: string) => void }) {
  const [tab, setTab] = useState<"Activity" | "Decisions" | "Artifacts">("Activity");
  const [selectedDocument, setSelectedDocument] = useState<string | null>(null);
  const [showRecords, setShowRecords] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const [showRunSnapshots, setShowRunSnapshots] = useState(false);
  const runs = useTaskFlowRuns(binding, online);
  const readDocuments = useRpc(listTaskDocuments);
  const documents = useQuery({ queryKey: ["mission-control", "flow-documents", binding.serverId, binding.workspaceId, binding.taskId], queryFn: () => readDocuments(binding), enabled: online, staleTime: 10_000, refetchInterval: online ? 15_000 : false, retry: false });
  const decisions = useDecisions(binding.serverId, online);
  const activity = recentActivity(documents.data?.documents ?? [], task.taskId);
  const runIssues = missingRunIssues(activity.events, runs.data?.runs);
  const entries = [...(decisions.data?.open ?? []), ...(decisions.data?.recent ?? [])].filter(entry => entry.decision.taskId === task.taskId && entry.decision.workspaceId === binding.workspaceId && entry.decision.serverId === binding.serverId);
  const allDocuments = documents.data?.documents ?? [];
  const openDocument = (name: string) => { setSelectedDocument(name); setShowRecords(name.startsWith("runs/")); setTab("Artifacts"); };
  const source = (name: string) => {
    const reference = resolveEvidence(name, allDocuments, task.taskId);
    return reference.kind === "document"
      ? <CompactLink key={name} label={artifactLabel(reference.document, activity.events)} icon="FileText" colors={colors} onPress={() => openDocument(reference.document.name)} />
      : <Text key={name} selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{reference.text}{reference.kind === "unavailable" ? " · Document not included in this view; availability has not been checked." : ""}</Text>;
  };
  const evidence = (references: string[]) => <EvidenceList references={references} documents={allDocuments} taskId={task.taskId} events={activity.events} colors={colors} openDocument={openDocument} />;
  const selected = documents.data?.documents.find(document => document.name === selectedDocument);
  const card = { borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: 10, gap: 7 };
  return <View style={{ gap: 12 }}>
    <TaskFlowSummary task={task} run={runs.data?.runs[0]} colors={colors} loading={online && runs.isPending} error={runs.isError ? String(runs.error) : !online ? "Host is offline; current run cannot be refreshed." : undefined} />
    <TaskAgents taskId={task.taskId} serverId={binding.serverId} online={online} colors={colors} runs={runs.data?.runs ?? []} events={activity.events} openAgent={openAgent} />
    <View accessibilityRole="tablist" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: 8 }}>{(["Activity", "Decisions", "Artifacts"] as const).map(name => <Pressable key={name} accessibilityRole="tab" accessibilityLabel={name} accessibilityState={{ selected: tab === name }} onPress={() => setTab(name)} style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 10, justifyContent: "center", borderBottomWidth: 2, borderBottomColor: tab === name ? colors.accent : "transparent", backgroundColor: pressed ? colors.surface2 : "transparent" })}><Text style={{ color: tab === name ? colors.accent : colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{name} · {name === "Activity" ? activity.events.length : name === "Decisions" ? entries.length : allDocuments.filter(document => !document.name.startsWith("runs/")).length}</Text></Pressable>)}</View>
    {!online ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Host offline. Records cannot be refreshed; any displayed records may be stale.</Text> : null}
    {tab === "Activity" ? <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Recent recorded activity · up to 5 updates from each of 3 recent runs. Recorded completion does not establish approval of the current revision.</Text>
      {documents.isPending && online ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Loading recent activity…</Text> : null}
      {documents.isError ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Activity unavailable: {String(documents.error)}</Text> : null}
      {activity.issues.length + runIssues.length ? <View style={{ gap: 5 }}>
        <CompactLink label={`Record issues · ${activity.issues.length + runIssues.length}`} icon="TriangleAlert" expanded={showIssues} colors={colors} onPress={() => setShowIssues(!showIssues)} />
        {showIssues ? [...activity.issues, ...runIssues].map((issue, index) => <Text key={`${issue.source}:${index}`} selectable style={{ color: colors.statusWarning, fontSize: 12 }}>{artifactLabel({ name: issue.source } as FlowDocument)}: {issue.reason}</Text>) : null}
      </View> : null}
      {documents.isSuccess && !activity.events.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No valid recent events available. This does not establish which stages happened.</Text> : null}
      {activity.events.map(event => <ActivityEntry key={event.eventId} event={event} documents={allDocuments} events={activity.events} taskId={task.taskId} serverId={binding.serverId} online={online} colors={colors} openAgent={openAgent} openDocument={openDocument} />)}
      {(runs.data?.runs ?? []).length ? <CompactLink label={`Run snapshots · ${runs.data!.runs.length}`} expanded={showRunSnapshots} colors={colors} onPress={() => setShowRunSnapshots(!showRunSnapshots)} /> : null}
      {(runs.data?.runs ?? []).some(run => { const latest = activity.events.find(event => event.runId === run.runId); return latest && (latest.stage !== run.stage || latest.outcome !== run.outcome); }) ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>A run snapshot differs from its latest available update. Expand run snapshots to inspect.</Text> : null}
      {showRunSnapshots ? (runs.data?.runs ?? []).map(run => {
        const latest = activity.events.find(event => event.runId === run.runId);
        return <View key={run.runId} style={card}>
          <Text style={{ color: colors.foreground, fontSize: 13 }}>Run snapshot · {formatDateTime(run.createdAt)} · {activityTitle(run)}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Next: {run.nextAction || "No next action recorded."} · {formatDateTime(run.updatedAt)}</Text>
          {latest && (latest.stage !== run.stage || latest.outcome !== run.outcome) ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Snapshot differs from the latest available event ({latest.stage} · {plain(latest.outcome)}). The records do not establish why.</Text> : null}
          {source(`runs/${run.runId}/run.md`)}
        </View>;
      }) : null}
    </View> : null}
    {tab === "Decisions" ? <View style={{ gap: 8 }}>
      {decisions.isPending && online ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Loading decisions…</Text> : null}
      {decisions.isError ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Decisions unavailable: {String(decisions.error)}</Text> : null}
      {decisions.isSuccess && !entries.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No decisions returned for this task.</Text> : null}
      {entries.map(entry => entry.decision.status === "open" && online ? <DecisionCard key={`${entry.decision.decisionId}:${entry.revision}`} entry={entry} serverId={binding.serverId} hostLabel={hostLabel} colors={colors} actions={{ describe: () => null, openAgent }} /> : <View key={entry.decision.decisionId} style={card}>
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>{entry.decision.kind} · {plain(entry.decision.status)}</Text>
        <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{entry.summary}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Requested {formatDateTime(entry.decision.requestedAt)}{entry.decision.resolvedAt ? ` · Resolved ${formatDateTime(entry.decision.resolvedAt)}` : ""}</Text>
        {entry.decision.note ? <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{entry.decision.note}</Text> : null}
        {entry.findings.map(finding => <Text key={finding.findingId} style={{ color: colors.foregroundMuted, fontSize: 12 }}>{finding.title} · {plain(finding.status)}</Text>)}
        {evidence(entry.decision.evidence)}
      </View>)}
    </View> : null}
    {tab === "Artifacts" ? <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Task documents · Markdown preview. Use Docs to edit.</Text>
      {documents.isPending && online ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Loading artifacts…</Text> : null}
      {documents.isError ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Artifacts unavailable: {String(documents.error)}</Text> : null}
      {selectedDocument && !selected && documents.isSuccess ? <View style={card}>
        <Text selectable style={{ color: colors.statusWarning, fontSize: 12 }}>The selected document is no longer in the returned artifacts. Its preview is unavailable.</Text>
        <CompactLink label="Clear selection" icon="X" colors={colors} onPress={() => setSelectedDocument(null)} />
      </View> : null}
      {allDocuments.filter(document => !document.name.startsWith("runs/")).map(document => <ArtifactCard key={document.name} document={document} documentPath={`Tasks/${task.taskId}/${document.name}`} events={activity.events} selected={selectedDocument === document.name} colors={colors} onSelect={() => setSelectedDocument(selectedDocument === document.name ? null : document.name)} />)}
      {allDocuments.some(document => document.name.startsWith("runs/")) ? <CompactLink label={`Run records · ${allDocuments.filter(document => document.name.startsWith("runs/")).length}`} expanded={showRecords} icon={showRecords ? "ChevronDown" : "ChevronRight"} colors={colors} onPress={() => setShowRecords(!showRecords)} /> : null}
      {showRecords ? allDocuments.filter(document => document.name.startsWith("runs/")).map(document => <ArtifactCard key={document.name} document={document} documentPath={`Tasks/${task.taskId}/${document.name}`} events={activity.events} selected={selectedDocument === document.name} colors={colors} onSelect={() => setSelectedDocument(selectedDocument === document.name ? null : document.name)} />) : null}
      {documents.isSuccess && !documents.data.documents.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No documents available.</Text> : null}
    </View> : null}
    <CompactLink label="Technical details" expanded={showTechnical} colors={colors} onPress={() => setShowTechnical(!showTechnical)} />
    {showTechnical ? <Text selectable style={{ color: colors.foregroundMuted, fontSize: 11 }}>Task ID: {task.taskId}{(runs.data?.runs ?? []).map(run => `\nRun ID: ${run.runId}${run.agentId ? ` · Agent ID: ${run.agentId}` : ""}`).join("")}{activity.events.map(event => `\nEvent ID: ${event.eventId}${event.agentId ? ` · Author ID: ${event.agentId}` : ""}`).join("")}</Text> : null}
  </View>;
}
