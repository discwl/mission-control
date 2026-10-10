import { getPaseoClient, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { RunRecord } from "../shared/runs";
import { listTaskDocuments } from "../shared/tasks";
import { CompactLink } from "./compact-link";
import { formatDateTime } from "./date-time";
import { MarkdownPreview } from "./markdown-preview";
import { useRoster } from "./roster";
import { toAgent, type Agent } from "./roster-model";
import { recentActivity, recordedOutcome, type FlowDocument, type FlowEvent } from "./task-flow-model";
import { activityBody, activityTitle, artifactLabel, artifactPreview, eventSummary, resolveEvidence } from "./task-flow-presentation";

type Colors = PluginSurfaceProps["theme"]["colors"];
type Binding = { serverId: string; workspaceId: string; taskId: string };

/** Mounted only while a row is expanded; the query shares the detail dialog's cache. */
export function TaskActivityPreview({ binding, online, colors }: { binding: Binding; online: boolean; colors: Colors }) {
  const read = useRpc(listTaskDocuments);
  const documents = useQuery({ queryKey: ["mission-control", "flow-documents", binding.serverId, binding.workspaceId, binding.taskId], queryFn: () => read(binding), enabled: online, staleTime: 10_000, refetchInterval: online ? 15_000 : false, retry: false });
  const activity = recentActivity(documents.data?.documents ?? [], binding.taskId);
  const latest = activity.events[0];
  return <View style={{ gap: 5, padding: 10, borderLeftWidth: 2, borderLeftColor: colors.border }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Latest recorded update</Text>
    {latest ? <>
      <Text style={{ color: latest.outcome === "blocked" || latest.outcome === "waiting" ? colors.statusWarning : colors.foregroundMuted, fontSize: 12 }}>{latest.stage} · {recordedOutcome(latest.outcome)} · {formatDateTime(latest.at)}</Text>
      <Text selectable numberOfLines={5} style={{ color: colors.foreground, fontSize: 12, lineHeight: 18 }}>{eventSummary(latest) || "No summary recorded."}</Text>
    </> : <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{documents.isPending && online ? "Loading activity…" : "No recorded update available."}</Text>}
    {documents.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning, fontSize: 12 }}>Activity could not be refreshed.</Text> : null}
    {activity.issues.length ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{activity.issues.length} record issue{activity.issues.length === 1 ? "" : "s"}; see full details.</Text> : null}
    {!online ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Host offline; displayed activity may be stale.</Text> : null}
  </View>;
}

export function ActivityEntry({ event, documents, events, taskId, serverId, online, colors, openAgent, openDocument }: { event: FlowEvent; documents: readonly FlowDocument[]; events: readonly FlowEvent[]; taskId: string; serverId: string; online: boolean; colors: Colors; openAgent: (id: string) => void; openDocument: (name: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const title = activityTitle(event);
  const icon = event.outcome === "completed" ? "SquareCheck" : event.outcome === "blocked" ? "TriangleAlert" : event.outcome === "waiting" ? "CirclePause" : "CirclePlay";
  const color = event.outcome === "completed" ? colors.statusSuccess : event.outcome === "blocked" || event.outcome === "waiting" ? colors.statusWarning : colors.accent;
  return <View style={{ borderBottomWidth: 1, borderBottomColor: colors.border }}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityHint="Show or hide this recorded update" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({ minHeight: 44, padding: 10, borderWidth: 1, borderColor: focused ? colors.accent : "transparent", borderRadius: 6, backgroundColor: pressed || hovered || expanded ? colors.surface2 : "transparent" })}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 9 }}>
        <View style={{ paddingTop: 2 }}><Icon name={icon} size={17} color={color} /></View>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>{title}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Recorded {formatDateTime(event.at)}</Text>
        </View>
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} />
      </View>
    </Pressable>
    {expanded ? <View style={{ gap: 10, padding: 10, paddingTop: 4 }}>
      <TaskAgents taskId={taskId} serverId={serverId} online={online} colors={colors} events={[event]} runs={[]} openAgent={openAgent} authorOnly />
      {activityBody(event) ? <MarkdownPreview content={activityBody(event)} colors={colors} documentPath={`Tasks/${taskId}/${event.source}`} /> : <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No summary recorded.</Text>}
      {event.outcome === "completed" && !event.evidence.length ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Completion recorded without evidence references.</Text> : null}
      <EvidenceList references={event.evidence} documents={documents} events={events} taskId={taskId} colors={colors} openDocument={openDocument} />
      {documents.some(document => document.name === event.source) ? <CompactLink label="View update record" icon="FileText" colors={colors} onPress={() => openDocument(event.source)} /> : null}
    </View> : null}
  </View>;
}

export function EvidenceList({ references, documents, events, taskId, colors, openDocument }: { references: string[]; documents: readonly FlowDocument[]; events: readonly FlowEvent[]; taskId: string; colors: Colors; openDocument: (name: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (!references.length) return null;
  const resolved = references.map(value => resolveEvidence(value, documents, taskId));
  const unavailable = resolved.filter(reference => reference.kind === "unavailable").length;
  return <View style={{ gap: 6 }}>
    <CompactLink label={`Evidence · ${references.length}${unavailable ? ` · ${unavailable} not included` : ""}`} icon={expanded ? "ChevronDown" : "ChevronRight"} expanded={expanded} colors={colors} onPress={() => setExpanded(!expanded)} />
    {expanded ? resolved.map((reference, index) => {
      if (reference.kind === "document") return <CompactLink key={index} label={artifactLabel(reference.document, events)} icon="FileText" colors={colors} onPress={() => openDocument(reference.document.name)} />;
      return <View key={index} style={{ gap: 2 }}>
        <Text selectable style={{ color: reference.kind === "unavailable" ? colors.statusWarning : colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{reference.text}</Text>
        {reference.kind === "unavailable" ? <Text style={{ color: colors.statusWarning, fontSize: 11 }}>Document not included in this view. Its availability has not been checked.</Text> : null}
      </View>;
    }) : null}
  </View>;
}

export function ArtifactCard({ document, events, selected, colors, onSelect, documentPath }: { document: FlowDocument; events: readonly FlowEvent[]; selected: boolean; colors: Colors; onSelect: () => void; documentPath?: string }) {
  const [raw, setRaw] = useState(false);
  const [technical, setTechnical] = useState(false);
  const event = events.find(candidate => candidate.source === document.name);
  return <View style={{ borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: 10, gap: 7 }}>
    <CompactLink label={artifactLabel(document, events)} icon="FileText" selected={selected} expanded={selected} colors={colors} onPress={onSelect} />
    <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{formatDateTime(event?.at ?? document.updatedAt)} · {document.editable ? "Editable in Docs" : "Read-only"}</Text>
    {selected ? <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <CompactLink label={raw ? "Markdown preview" : "Raw source"} selected={raw} colors={colors} onPress={() => setRaw(!raw)} />
        <CompactLink label="Technical details" expanded={technical} colors={colors} onPress={() => setTechnical(!technical)} />
      </View>
      {technical ? <Text selectable style={{ color: colors.foregroundMuted, fontSize: 11 }}>{document.name}</Text> : null}
      {raw ? <Text selectable style={{ color: colors.foreground, fontSize: 12, lineHeight: 18 }}>{document.content}</Text> : <MarkdownPreview content={artifactPreview(document)} colors={colors} documentPath={documentPath} />}
    </> : null}
  </View>;
}

/** Recorded authors and task-labelled agents are distinct from current live activity. */
export function TaskAgents({ taskId, serverId, online, colors, runs, events, openAgent, authorOnly = false }: { taskId: string; serverId: string; online: boolean; colors: Colors; runs: readonly RunRecord[]; events: readonly FlowEvent[]; openAgent: (id: string) => void; authorOnly?: boolean }) {
  const roster = useRoster(serverId, online);
  const recorded = new Set([...(authorOnly ? [] : runs.map(run => run.agentId)), ...events.map(event => event.agentId)].filter((id): id is string => Boolean(id)));
  const directoryAgents = (roster.data?.agents ?? []).filter(agent => recorded.has(agent.id) || (!authorOnly && agent.taskId === taskId));
  const missingIds = [...recorded].filter(id => !directoryAgents.some(agent => agent.id === id));
  const fetched = useQuery({
    queryKey: ["mission-control", "recorded-agents", serverId, ...missingIds],
    queryFn: async (): Promise<Agent[]> => {
      const paseo = getPaseoClient(serverId);
      const results = await Promise.all(missingIds.map(async id => {
        try {
          const result = await paseo.agents.ref(id).refresh();
          return result?.agent ? toAgent(result.agent) : null;
        } catch { return null; }
      }));
      return results.filter((agent): agent is Agent => agent !== null);
    },
    enabled: online && missingIds.length > 0,
    staleTime: 30_000,
  });
  const agents = [...directoryAgents, ...(fetched.data ?? [])];
  const unresolved = missingIds.filter(id => !agents.some(agent => agent.id === id));
  const rows = [
    ...agents.map(agent => ({ id: agent.id, name: agent.name, status: agent.status.replaceAll("_", " "), parentAgentId: agent.parentAgentId })),
    ...unresolved.map(id => ({ id, name: `Recorded agent · ${id.slice(0, 8)}`, status: null, parentAgentId: null })),
  ];
  return <View style={{ gap: 6 }}>
    {!authorOnly ? <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>Agents · {rows.length}</Text> : null}
    {rows.map(agent => <View key={agent.id} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <Text style={{ color: colors.foreground, fontSize: 12, flexShrink: 1 }}>{authorOnly ? `Recorded by ${agent.name}` : agent.name}</Text>
      {!authorOnly && agent.status ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{online ? agent.status : `Last observed: ${agent.status}`}{agent.parentAgentId ? " · Subagent" : ""}</Text> : null}
      {online ? <CompactLink label={`Open ${agent.name}`} accessibilityLabel={`Open ${authorOnly ? "author" : "agent"} ${agent.name}`} icon="ArrowUpRight" colors={colors} onPress={() => openAgent(agent.id)} /> : null}
    </View>)}
    {roster.isPending && online ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Loading agents…</Text> : null}
    {unresolved.length && fetched.isFetching ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Loading recorded agent details…</Text> : null}
    {unresolved.length && !fetched.isFetching ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Details unavailable for {unresolved.length} recorded agent{unresolved.length === 1 ? "" : "s"}.</Text> : null}
    {!rows.length && !roster.isPending ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{authorOnly ? "No author recorded." : "No linked agents recorded."}</Text> : null}
  </View>;
}
