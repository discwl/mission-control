import { useRpc as useInstallationRpc, type PluginClientContext, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { readFleet, type FleetSnapshot } from "../shared/fleet";
import { listTaskDocuments } from "../shared/tasks";
import { decisionReceipt } from "../shared/decision-receipt";
import { CompactLink } from "./compact-link";
import { formatDateTime } from "./date-time";
import { HostRpcProvider, useMissionControlCopy, useRpc } from "./host-rpc";
import { MarkdownPreview } from "./markdown-preview";
import { buildV2Tasks, missionControlV2ScreenId, retainV2Hosts, v2TasksForView, v2Workspace, type V2Task, type V2View } from "./mission-control-v2-model";

type Colors = PluginSurfaceProps["theme"]["colors"];
const views = ["Needs you", "Work", "Up next"] as const;
const detailTabs = ["Summary", "Evidence", "Telegram", "Activity"] as const;
const when = (value: string | null | undefined) => value ? formatDateTime(value) : "Not recorded";
const problem = (error: unknown) => error instanceof Error ? error.message : String(error);
const tone = (row: V2Task, colors: Colors) => ["Needs you", "Blocked", "Unconfirmed"].includes(row.state) ? colors.statusWarning : row.state === "Working" ? colors.statusSuccess : colors.foregroundMuted;

function ReadOnlyDocuments({ row, colors, workspaceId }: { row: V2Task; colors: Colors; workspaceId: string }) {
  const read = useRpc(listTaskDocuments);
  const [selected, setSelected] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const online = row.state !== "Unconfirmed";
  const query = useQuery({ queryKey: ["mission-control", "flow-documents", row.serverId, workspaceId, row.entry.task.taskId], queryFn: () => read({ serverId: row.serverId, workspaceId, taskId: row.entry.task.taskId }), enabled: online, staleTime: 10_000, retry: false });
  const documents = query.data?.documents ?? [];
  return <View style={{ gap: 10 }}>
    <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 15 }}>Saved task documents · read-only</Text>
    {query.isPending && online ? <Text style={{ color: colors.foregroundMuted }}>Reading evidence from {row.hostLabel}…</Text> : null}
    {query.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>Evidence unavailable: {problem(query.error)}</Text> : null}
    {!online ? <Text style={{ color: colors.statusWarning }}>Host unconfirmed. Cached documents may be out of date.</Text> : null}
    {!documents.length && !query.isPending ? <Text style={{ color: colors.foregroundMuted }}>No documents returned. Missing evidence does not establish completion.</Text> : null}
    {(all ? documents : documents.slice(0, 20)).map(doc => <View key={doc.name} style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 9, gap: 5 }}>
      <CompactLink label={doc.name} icon="FileText" colors={colors} selected={selected === doc.name} expanded={selected === doc.name} onPress={() => setSelected(selected === doc.name ? null : doc.name)} />
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Saved {when(doc.updatedAt)}</Text>
      {selected === doc.name ? <MarkdownPreview content={doc.content} colors={colors} documentPath={`Tasks/${row.entry.task.taskId}/${doc.name}`} /> : null}
    </View>)}
    {!all && documents.length > 20 ? <CompactLink label={`Show all ${documents.length} documents`} colors={colors} onPress={() => setAll(true)} /> : null}
  </View>;
}

function Evidence({ row, colors }: { row: V2Task; colors: Colors }) {
  const bridge = useMissionControlCopy(row.serverId);
  const workspaceId = v2Workspace(row);
  const latest = [...row.entry.decisions].sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt))[0];
  return <View style={{ gap: 16 }}>
    <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Saved evidence is not live candidate verification. V2 cannot approve a plan, accept code or authorize delivery.</Text>
    {row.staleReview ? <Text style={{ color: colors.statusWarning }}>Saved review and current run disagree. Fresh review is required.</Text> : null}
    <Text style={{ color: colors.foregroundMuted }}>{row.workflow.evidence}</Text>
    {latest ? <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground, fontWeight: "600" }}>{latest.decision.kind === "plan" ? "Plan request" : "Review request"} · {latest.decision.status.replaceAll("_", " ")}</Text>
      <Text selectable style={{ color: colors.foreground }}>{latest.summary || latest.decision.question}</Text>
      {latest.decision.plain?.checks?.map((check, index) => <Text key={`check:${index}`} style={{ color: colors.foregroundMuted }}>Recorded check: {check}</Text>)}
      {latest.decision.plain?.limitations?.map((limitation, index) => <Text key={`limit:${index}`} style={{ color: colors.statusWarning }}>Limitation: {limitation}</Text>)}
      {latest.decision.reviewVerification?.reviewers.map(reviewer => <Text key={reviewer.checkpointId} style={{ color: colors.foregroundMuted, fontSize: 12 }}>{reviewer.model} · {reviewer.profile} · {reviewer.reviewed}/{reviewer.selected} selected files reviewed · {reviewer.excluded} excluded</Text>)}
      {latest.findings.map(finding => <View key={finding.findingId} style={{ gap: 4, paddingVertical: 8, borderTopColor: colors.border, borderTopWidth: 1 }}>
        <Text style={{ color: colors.foreground, fontWeight: "600" }}>{finding.title} · {finding.severity} · {finding.status.replaceAll("_", " ")}</Text><Text selectable style={{ color: colors.foregroundMuted }}>{finding.plain?.description ?? finding.detail}</Text>
      </View>)}
    </View> : <Text style={{ color: colors.foregroundMuted }}>No saved approval or review request was returned.</Text>}
    {row.entry.run ? <View style={{ gap: 5 }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>Recorded revision</Text><Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{row.entry.run.gitHead ?? "Commit unknown"}{row.entry.run.gitDirty ? " · working changes recorded" : ""}</Text></View> : null}
    {workspaceId && "copy" in bridge ? <HostRpcProvider copy={bridge.copy}><ReadOnlyDocuments key={`${row.key}:${workspaceId}`} row={row} colors={colors} workspaceId={workspaceId} /></HostRpcProvider>
      : <Text style={{ color: colors.statusWarning }}>{workspaceId ? "Connect to this host's Mission Control copy to read its documents." : "No task-owned workspace could be verified for reading documents."}</Text>}
  </View>;
}

function TaskSummary({ row, snapshot, colors, openAgent }: { row: V2Task; snapshot: FleetSnapshot; colors: Colors; openAgent: (serverId: string, agentId: string) => void }) {
  const [workers, setWorkers] = useState(false);
  const [criteria, setCriteria] = useState(false);
  return <View style={{ gap: 15 }}>
    <View style={{ backgroundColor: colors.surface2, borderRadius: 7, padding: 13, gap: 6 }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>Waiting on {row.waitingOn.toLowerCase()}</Text><Text selectable style={{ color: tone(row, colors), lineHeight: 21 }}>{row.next}</Text></View>
    {row.limited ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>This host returned limited data. Missing records do not establish completion.</Text> : null}
    {row.entry.problem ? <Text selectable style={{ color: colors.statusWarning }}>{row.entry.problem}</Text> : null}
    {row.entry.questions.filter(item => item.question.status === "open").map(item => <View key={item.question.questionId} style={{ gap: 6 }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>Saved question</Text><Text selectable style={{ color: colors.foreground }}>{item.question.question}</Text>{item.question.plain ? <Text style={{ color: colors.foregroundMuted }}>{item.question.plain.status}</Text> : null}</View>)}
    {row.entry.decisions.filter(item => item.decision.status === "open").map(item => <View key={item.decision.decisionId} style={{ gap: 6 }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>{item.decision.kind === "plan" ? "Saved plan request" : "Saved review request"}</Text><Text selectable style={{ color: colors.foreground }}>{item.decision.plain?.built ?? item.summary ?? item.decision.question}</Text>{item.decision.plain?.found ? <Text style={{ color: colors.foregroundMuted }}>{item.decision.plain.found}</Text> : null}</View>)}
    <CompactLink label={`Acceptance criteria · ${criteria ? "Hide" : "Show"}`} expanded={criteria} colors={colors} onPress={() => setCriteria(!criteria)} />
    {criteria ? <MarkdownPreview content={row.entry.task.acceptanceCriteria} colors={colors} /> : null}
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Workflow record {when(row.updatedAt)} · Host observed {when(row.observedAt)}</Text>
    {row.queue.length ? <View style={{ gap: 6 }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>Recorded queue · priority {row.priority}/9</Text><Text style={{ color: colors.foregroundMuted }}>{snapshot.state.paused ? "Supervisor wake-ups are paused. " : ""}{row.state === "Queued" ? "The existing coordinator checks eligibility before starting the next phase." : `Current hold or state: ${row.next}`}</Text><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>V2 does not configure structured task dependencies or new concurrency rules.</Text></View> : null}
    <CompactLink label={`${row.workers.length} linked worker${row.workers.length === 1 ? "" : "s"} · ${workers ? "Hide" : "Show"}`} icon={workers ? "ChevronDown" : "ChevronRight"} expanded={workers} colors={colors} onPress={() => setWorkers(!workers)} />
    {workers ? <View style={{ gap: 9 }}>{row.workers.map(worker => <View key={worker.id} style={{ gap: 5, paddingVertical: 9, borderTopWidth: 1, borderTopColor: colors.border }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>{worker.name}</Text><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{worker.archivedAt ? "Archived" : worker.status.replaceAll("_", " ")}{row.state === "Unconfirmed" ? " · last known" : ""} · {when(worker.activityAt ?? worker.updatedAt)}{worker.pendingPermissions ? ` · ${worker.pendingPermissions} permissions` : ""}</Text>{worker.error ? <Text style={{ color: colors.statusWarning }}>{worker.error}</Text> : null}<CompactLink label="Open worker conversation" icon="ArrowUpRight" colors={colors} disabled={row.state === "Unconfirmed"} onPress={() => openAgent(row.serverId, worker.id)} /></View>)}{!row.workers.length ? <Text style={{ color: colors.foregroundMuted }}>No task-labelled, run-bound or explicitly linked worker returned. Workspace co-location alone does not establish ownership.</Text> : null}</View> : null}
    {row.coordinators.length ? <View style={{ gap: 6 }}><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Coordinator ownership</Text>{row.coordinators.map(owner => <CompactLink key={owner.agentId} label={owner.name} colors={colors} onPress={() => openAgent(snapshot.serverId, owner.agentId)} />)}</View> : <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No coordinator ownership recorded. This task is visible from its host snapshot.</Text>}
  </View>;
}

function TaskDetail({ row, snapshot, colors, navigation, close, compact, onError }: { row: V2Task; snapshot: FleetSnapshot; colors: Colors; navigation: PluginSurfaceProps["navigation"]; close: () => void; compact: boolean; onError: (error: string) => void }) {
  const [tab, setTab] = useState<typeof detailTabs[number]>("Summary");
  const [technical, setTechnical] = useState(false);
  const decisions = [...row.entry.decisions].sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt));
  const latestReceipt = decisions.find(item => item.decision.status !== "open");
  const receipt = latestReceipt ? decisionReceipt(latestReceipt, row.hostLabel, row.entry.decisions) : null;
  const events = snapshot.state.events.filter(event => event.remoteServerId === row.serverId && event.taskId === row.entry.task.taskId).sort((a, b) => b.at.localeCompare(a.at));
  const workspaceId = v2Workspace(row);
  const openAgent = (serverId: string, agentId: string) => {
    try { if (!navigation) throw new Error("Conversation navigation unavailable here."); navigation.openAgent({ serverId, agentId }); }
    catch (error) { onError(problem(error)); }
  };
  return <View style={{ gap: 17, padding: compact ? 16 : 23 }}>
    {compact ? <CompactLink label="Back to task list" icon="ArrowLeft" colors={colors} onPress={close} /> : null}
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{row.hostLabel} · {row.entry.task.ticket?.key ?? row.entry.task.projectId}</Text>
    <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 22, fontWeight: "600", lineHeight: 29 }}>{row.entry.task.title}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}><Text style={{ color: tone(row, colors), fontWeight: "600" }}>{row.state}</Text><Text style={{ color: colors.foregroundMuted }}>{row.workflow.stage}</Text><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Read-only</Text></View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>{detailTabs.map(name => <CompactLink key={name} label={name} selected={tab === name} colors={colors} onPress={() => setTab(name)} />)}</ScrollView>
    {tab === "Summary" ? <TaskSummary row={row} snapshot={snapshot} colors={colors} openAgent={openAgent} /> : tab === "Evidence" ? <Evidence row={row} colors={colors} /> : tab === "Telegram" ? <>
      <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 15 }}>Shared saved-decision receipt</Text><Text style={{ color: colors.foregroundMuted }}>The same receipt formatter as Mission Control chat and Telegram. No Telegram message is sent or edited here.</Text>
      {receipt ? <View style={{ backgroundColor: colors.surface2, borderRadius: 7, padding: 14, gap: 10 }}><Text style={{ color: colors.accent, fontWeight: "600" }}>{receipt.context.status}</Text><Text selectable style={{ color: colors.foreground, lineHeight: 21 }}>{receipt.text}</Text><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Saved {when(receipt.context.observedAt)}</Text></View> : <Text style={{ color: colors.foregroundMuted }}>No resolved decision receipt returned for this task.</Text>}
      <Text style={{ color: colors.statusWarning, fontSize: 12 }}>“Sent to worker” records delivery, not verified worker progress or task completion. Telegram transport receipt availability is separate.</Text>
    </> : <>
      <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>Recorded workflow activity</Text>{!events.length ? <Text style={{ color: colors.foregroundMuted }}>No coordinator events returned. Saved run documents may contain more history.</Text> : null}
      {events.slice(0, 30).map(event => <View key={event.id} style={{ gap: 5, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 }}><Text style={{ color: colors.foreground }}>{event.message}</Text><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{when(event.at)} · {event.kind}</Text></View>)}
      {events.length > 30 ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Latest 30 of {events.length} returned events. Not a complete audit log.</Text> : null}
    </>}
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 14, gap: 9 }}><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Preview only. Decisions and delivery continue through the existing workflow and its revision checks.</Text>
      {workspaceId ? <CompactLink label="Open owning workspace" icon="ArrowUpRight" colors={colors} disabled={row.state === "Unconfirmed" || !navigation} onPress={() => { try { navigation?.openWorkspace({ serverId: row.serverId, workspaceId }); } catch (error) { onError(problem(error)); } }} /> : null}
      <CompactLink label={technical ? "Hide record identifiers" : "Record identifiers"} expanded={technical} colors={colors} onPress={() => setTechnical(!technical)} />
      {technical ? <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{row.serverId}{"\n"}{row.entry.task.taskId}{"\n"}{row.entry.run?.runId ?? "No run"}{"\n"}{workspaceId ?? "Workspace not verified"}</Text> : null}
    </View>
  </View>;
}

function TaskList({ rows, view, selected, colors, unavailable, choose, clear }: { rows: V2Task[]; view: V2View; selected?: string; colors: Colors; unavailable: number; choose: (key: string) => void; clear: () => void }) {
  const [count, setCount] = useState(50);
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  return <View style={{ padding: 15, gap: 0 }}>
    <Text accessibilityRole="header" style={{ color: colors.foregroundMuted, fontSize: 12, padding: 8, paddingBottom: 13 }}>{view === "Needs you" ? "Oldest saved request first" : view === "Up next" ? "Recorded priority order" : "Latest workflow update first"} · {rows.length} tasks</Text>
    {!rows.length ? <View style={{ padding: 20, gap: 10 }}><Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "600" }}>No matching {view === "Needs you" ? "saved requests" : "tasks"}</Text><Text style={{ color: colors.foregroundMuted }}>{unavailable ? "Some hosts are unavailable. This does not confirm their task state." : view === "Up next" ? "No enabled queue entries returned. Existing queues are configured in Orchestrator." : "Try another host or search. Unread chat alone does not create a decision."}</Text><CompactLink label="Clear filters" colors={colors} onPress={clear} /></View> : null}
    {rows.slice(0, count).map(row => <Pressable key={row.key} accessibilityRole="button" accessibilityLabel={`${row.hostLabel} · ${row.entry.task.ticket?.key ?? row.entry.task.title} · ${row.state}`} accessibilityState={{ selected: selected === row.key }} onFocus={() => setFocused(row.key)} onBlur={() => setFocused(null)} onHoverIn={() => setHovered(row.key)} onHoverOut={() => setHovered(null)} onPress={() => choose(row.key)} style={({ pressed }) => ({ padding: 15, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border, borderWidth: 1, borderColor: focused === row.key ? colors.accent : "transparent", borderRadius: 7, backgroundColor: selected === row.key || pressed || hovered === row.key ? colors.surface2 : "transparent" })}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{row.hostLabel} · {row.entry.task.ticket?.key ?? row.entry.task.projectId}</Text><Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600", lineHeight: 22 }}>{row.entry.task.title}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 9 }}><Text style={{ color: tone(row, colors), fontWeight: "600", fontSize: 12 }}>{row.state}</Text><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{row.workflow.stage}{view === "Up next" ? ` · priority ${row.priority}/9` : ""}</Text></View><Text numberOfLines={3} style={{ color: colors.foregroundMuted, lineHeight: 20 }}>{row.next.length > 180 ? `${row.next.slice(0, 177)}…` : row.next}</Text><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{when(row.updatedAt)}</Text>
    </Pressable>)}
    {rows.length > count ? <View style={{ paddingTop: 14, gap: 7 }}><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Showing {count} of {rows.length} matching tasks.</Text><CompactLink label="Show 50 more" colors={colors} onPress={() => setCount(count + 50)} /></View> : null}
    <Text style={{ color: colors.foregroundMuted, fontSize: 12, padding: 12, paddingTop: 22 }}>One item per host/task identity, even with several coordinators or workers. Distinct saved records are not silently merged by ticket title.</Text>
  </View>;
}

export function MissionControlV2({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const colors = theme.colors;
  const read = useInstallationRpc(readFleet);
  const query = useQuery({ queryKey: ["mission-control", "fleet", host.id], queryFn: () => read({ refresh: true }), refetchInterval: 20_000, retry: false });
  const previous = useRef<FleetSnapshot | null>(null);
  const snapshot = useMemo(() => query.data ? retainV2Hosts(query.data, previous.current) : undefined, [query.data]);
  useEffect(() => { if (snapshot) previous.current = snapshot; }, [snapshot]);
  const rows = useMemo(() => snapshot ? buildV2Tasks(snapshot, { unconfirmed: query.isError }) : [], [snapshot, query.isError]);
  const [view, setView] = useState<V2View>("Needs you");
  const [filterHost, setFilterHost] = useState("all");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [warnings, setWarnings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const compact = layout.compact || width < 1000;
  const visible = v2TasksForView(rows, view, filterHost, search);
  const selected = visible.find(row => row.key === selection) ?? (!compact ? visible[0] : undefined);
  const focused = compact && Boolean(selected);
  const issues = snapshot?.hosts.filter(remote => remote.error || !remote.snapshot || !remote.snapshot.complete) ?? [];
  const unavailable = snapshot?.hosts.filter(remote => remote.error || !remote.snapshot) ?? [];
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flex: 1, backgroundColor: colors.surface0 }}>
    <View style={{ padding: compact ? 16 : 24, gap: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}><View style={{ flex: 1, minWidth: 200, gap: 5 }}><Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: focused ? 18 : 27, fontWeight: "700" }}>Mission Control V2</Text>{!focused ? <Text style={{ color: colors.foregroundMuted }}>Your tasks and next decisions. Orchestrators keep coordinating the work.</Text> : null}</View><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Read-only preview</Text><CompactLink label={query.isFetching ? "Refreshing…" : "Refresh"} colors={colors} disabled={query.isFetching} onPress={() => void query.refetch()} /></View>
      {error ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>{error}</Text> : null}
      {query.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>Refresh failed. Records are unconfirmed: {problem(query.error)}</Text> : null}
      {!focused ? <>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{views.map(name => <CompactLink key={name} label={`${name} · ${v2TasksForView(rows, name, filterHost).length}`} colors={colors} selected={view === name} onPress={() => { setView(name); setSelection(null); }} />)}</View>
        <TextInput accessibilityLabel="Search Mission Control V2 tasks" value={search} onChangeText={value => { setSearch(value); setSelection(null); }} placeholder="Find a ticket, task, host or blocker" placeholderTextColor={colors.foregroundMuted} style={{ color: colors.foreground, backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 7, padding: 11 }} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7 }}><CompactLink label="All hosts" selected={filterHost === "all"} colors={colors} onPress={() => { setFilterHost("all"); setSelection(null); }} />{[...(snapshot?.hosts ?? [])].sort((a, b) => a.label.localeCompare(b.label) || a.serverId.localeCompare(b.serverId)).map(remote => <CompactLink key={remote.serverId} label={`${remote.label}${remote.error || !remote.snapshot ? " · unavailable" : ""}`} selected={filterHost === remote.serverId} colors={colors} onPress={() => { setFilterHost(remote.serverId); setSelection(null); }} />)}</ScrollView>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Observed {when(snapshot?.observedAt)} · {rows.length} task records · {rows.filter(row => row.state === "Working").length} working</Text>{issues.length || snapshot?.warnings.length ? <CompactLink label={`${unavailable.length} unavailable · ${issues.length - unavailable.length} limited${snapshot?.warnings.length ? ` · ${snapshot.warnings.length} notices` : ""} · ${warnings ? "Hide" : "Details"}`} expanded={warnings} colors={colors} onPress={() => setWarnings(!warnings)} /> : null}</View>
        {warnings ? <View style={{ gap: 7 }}>{issues.map(remote => <Text key={remote.serverId} selectable style={{ color: colors.statusWarning, fontSize: 12 }}>{remote.label}: {remote.error ?? remote.snapshot?.warnings.join(" · ") ?? "No snapshot returned"}{remote.snapshot ? ` · last observed ${when(remote.snapshot.observedAt)}` : ""}</Text>)}{snapshot?.warnings.map((warning, index) => <Text key={index} style={{ color: colors.statusWarning, fontSize: 12 }}>{warning}</Text>)}</View> : null}
        {unavailable.length ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Unavailable hosts are not clear of work. Known records remain unconfirmed.</Text> : null}
        {view === "Up next" ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Recorded priorities, highest first. Holds describe saved state. V2 neither schedules work nor creates dependency rules.{snapshot?.state.paused ? " Supervisor wake-ups are paused." : ""}</Text> : null}
      </> : null}
    </View>
    {query.isPending ? <View style={{ padding: 24 }}><Text style={{ color: colors.foregroundMuted }}>Reading task records from the orchestrator's managed hosts…</Text></View> : null}
    <View style={{ flex: 1, minHeight: 0, flexDirection: compact ? "column" : "row" }}>
      {!focused ? <ScrollView style={{ flex: compact ? 1 : 0.42, minWidth: 0 }}><TaskList key={`${view}:${filterHost}:${search}`} rows={visible} view={view} selected={selected?.key} colors={colors} unavailable={unavailable.length} choose={key => { setSelection(key); setError(null); }} clear={() => { setSearch(""); setFilterHost("all"); }} /></ScrollView> : null}
      {selected && snapshot ? <ScrollView key={selected.key} style={{ flex: compact ? 1 : 0.58, minWidth: 0, borderLeftWidth: compact ? 0 : 1, borderLeftColor: colors.border }}><TaskDetail row={selected} snapshot={snapshot} colors={colors} navigation={navigation} close={() => setSelection(null)} compact={compact} onError={setError} /></ScrollView>
        : !compact ? <View style={{ flex: 1, padding: 28, borderLeftWidth: 1, borderLeftColor: colors.border, gap: 10 }}><Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "600" }}>Select a task</Text><Text style={{ color: colors.foregroundMuted }}>Read its next action, evidence, receipts and worker history here.</Text></View> : null}
    </View>
  </View>;
}

export function registerMissionControlV2(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: missionControlV2ScreenId, title: "Mission Control V2", Component: MissionControlV2 }),
    client.addSidebarHeaderItem({ id: missionControlV2ScreenId, title: "Mission Control V2", Component: ({ currentScreen, openScreen }) => <SidebarRow icon="PanelsTopLeft" active={currentScreen?.screenId === missionControlV2ScreenId} onPress={() => openScreen({ screenId: missionControlV2ScreenId })} /> }),
    client.addCommandCenterItem({ id: "open-mission-control-v2", title: "Open Mission Control V2", icon: "PanelsTopLeft", context: "global", keywords: ["preview", "v2", "tasks", "decisions"], onSelect: () => client.openScreen({ screenId: missionControlV2ScreenId }) }),
    client.addSlashCommand({ name: "mission-control-v2", description: "Open the read-only Mission Control V2 preview", argumentHint: "", context: "workspace", onSubmit: () => client.openScreen({ screenId: missionControlV2ScreenId }) }),
  ];
  return () => removers.forEach(remove => remove());
}
