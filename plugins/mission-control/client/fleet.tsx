import { useRpc, type PluginClientContext, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { acknowledgeFleetDispatch, configureSupervisor, fleetScreenId, pauseFleet, readFleet, reconcileFleet, setFleetQueue, type FleetCoordinator, type FleetSnapshot } from "../shared/fleet";
import { managedTasks, managedWorkerIds, taskWorkflow, taskWorkers, workflowStages } from "../shared/fleet-model";
import { setOrchestratorWork } from "../shared/orchestrator-work";
import { CompactLink } from "./compact-link";
import { navigateWithCoordinatorReturn } from "./coordinator-return";
import { formatDateTime } from "./date-time";
import { PageScrollView, usePageState } from "./page-state";
import { pageKey, pageMemory } from "./page-memory";
import { FleetTaskDetail, FleetWorkerTree } from "./fleet-task";
import { hasOpenPlan, taskDestination, taskTabKey } from "./fleet-navigation";

type Colors = PluginSurfaceProps["theme"]["colors"];
type Selection = { coordinatorId: string; taskId: string } | null;
type ViewName = "Overview" | "Work queue" | "Needs you" | "Plans" | "Review" | "Activity" | "Supervisor";
const date = (value: string | null | undefined) => value ? formatDateTime(value) : "Not yet";
const problem = (error: unknown) => error instanceof Error ? error.message : String(error);

function CoordinatorSettings({ coordinator, snapshot, colors, act, busy, openAgent }: { coordinator: FleetCoordinator; snapshot: FleetSnapshot; colors: Colors; act: (key: string, work: () => Promise<unknown>) => void; busy: boolean; openAgent: (serverId: string, agentId: string) => void }) {
  const setting = snapshot.state.coordinators.find(item => item.agentId === coordinator.agentId);
  const configure = useRpc(configureSupervisor); const reconcile = useRpc(acknowledgeFleetDispatch);
  const link = useRpc(setOrchestratorWork);
  const [confirming, setConfirming] = useState(false); const [linking, setLinking] = useState(false); const [search, setSearch] = useState("");
  const [interval, setInterval] = useState(setting?.intervalMinutes ?? 5); const [limit, setLimit] = useState(setting?.maxWakeupsPerDay ?? 24);
  const host = snapshot.hosts.find(item => item.serverId === coordinator.remoteServerId);
  const agents = host?.snapshot?.agents ?? [];
  const ids = managedWorkerIds(snapshot.serverId, coordinator, agents);
  const linked = new Set(coordinator.links.map(item => item.remoteAgentId));
  const queued = snapshot.state.queue.filter(item => item.coordinatorId === coordinator.agentId && item.remoteServerId === coordinator.remoteServerId && item.enabled).length;
  const save = (enabled: boolean) => act(coordinator.agentId, async () => { await configure({ agentId: coordinator.agentId, remoteServerId: coordinator.remoteServerId, enabled, intervalMinutes: interval, maxWakeupsPerDay: limit, expectedRevision: snapshot.state.revision }); setConfirming(false); });
  return <View style={{ padding: 16, gap: 10, backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 9 }}>
    <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600" }}>{coordinator.hostLabel} · {coordinator.name}</Text>
    <Text style={{ color: setting?.enabled ? colors.accent : colors.foregroundMuted }}>{setting?.enabled ? "Enrolled" : "Paused"} · {queued} queued tasks · {ids.size} managed workers</Text>
    <Text style={{ color: colors.foregroundMuted }}>{setting?.message ?? "Automatic work is off. Enroll this coordinator and queue specific tasks to begin."}</Text>
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Last check {date(setting?.lastCheckedAt)} · Next check {date(setting?.nextCheckAt)} · {setting?.date === new Date().toISOString().slice(0, 10) ? setting.wakeups : 0}/{setting?.maxWakeupsPerDay ?? limit} wake-ups today (UTC)</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <CompactLink label="Open coordinator" colors={colors} onPress={() => openAgent(snapshot.serverId, coordinator.agentId)} />
      <CompactLink label={linking ? "Hide worker links" : "Link existing workers"} colors={colors} onPress={() => setLinking(!linking)} />
      <CompactLink label={setting?.enabled ? "Pause coordinator" : "Configure automatic work"} colors={colors} disabled={busy} onPress={() => setting?.enabled ? save(false) : setConfirming(!confirming)} />
    </View>
    {setting?.pending ? <View style={{ gap: 8 }}>
      <Text selectable style={{ color: colors.statusWarning }}>Unconfirmed dispatch at {date(setting.pending.attemptedAt)}. Open the coordinator and inspect this attempt before clearing it: {setting.pending.requestId}</Text>
      <CompactLink label="I checked this attempt; clear it and stay paused" colors={colors} disabled={busy} onPress={() => act(coordinator.agentId, () => reconcile({ agentId: coordinator.agentId, requestId: setting.pending!.requestId, expectedRevision: snapshot.state.revision }))} />
    </View> : null}
    {confirming ? <View style={{ padding: 12, gap: 10, borderColor: colors.accent, borderWidth: 1, borderRadius: 7 }}>
      <Text style={{ color: colors.foreground }}>Continue queued work while this daemon is running, including weekends. Questions, permissions, plan and review decisions stop the affected task. Delivery always needs separate approval.</Text>
      <Text style={{ color: colors.foregroundMuted }}>The coordinator and workers keep their configured tool permissions. Review those permissions before unattended work; this scheduler does not sandbox external tools.</Text>
      <Text style={{ color: colors.foregroundMuted }}>Check interval</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{[5, 15, 30, 60].map(value => <CompactLink key={value} label={`${value} min`} colors={colors} selected={interval === value} onPress={() => setInterval(value)} />)}</View>
      <Text style={{ color: colors.foregroundMuted }}>Daily wake-up limit (not a spending cap)</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{[6, 12, 24, 48].map(value => <CompactLink key={value} label={String(value)} colors={colors} selected={limit === value} onPress={() => setLimit(value)} />)}</View>
      <CompactLink label={`Enable for ${coordinator.hostLabel}`} colors={colors} disabled={busy || Boolean(setting?.pending) || !host?.snapshot?.complete || Boolean(host.error)} onPress={() => save(true)} />
      <CompactLink label="Cancel" colors={colors} onPress={() => setConfirming(false)} />
    </View> : null}
    {linking ? <View style={{ gap: 9 }}>
      <Text style={{ color: colors.foregroundMuted }}>This picker shows all workers on {coordinator.hostLabel}. Linking adds ownership for this chat; it does not launch work or establish authorship of shared files.</Text>
      <TextInput accessibilityLabel={`Find workers on ${coordinator.hostLabel}`} value={search} onChangeText={setSearch} placeholder="Find a worker" placeholderTextColor={colors.foregroundMuted} style={{ color: colors.foreground, padding: 10, borderColor: colors.border, borderWidth: 1, borderRadius: 6 }} />
      {!host?.snapshot ? <Text style={{ color: colors.statusWarning }}>{host?.error ?? "Host snapshot unavailable."}</Text> : null}
      {[...agents].filter(agent => agent.workspaceId && (!agent.archivedAt || linked.has(agent.id)) && agent.name.toLowerCase().includes(search.toLowerCase())).sort((a, b) => (b.activityAt ?? "").localeCompare(a.activityAt ?? "")).slice(0, 50).map(agent => <View key={agent.id} style={{ paddingVertical: 8, gap: 4, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text style={{ color: colors.foreground }}>{agent.name}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{agent.status} · {date(agent.activityAt)} · {host?.snapshot?.workspaces.find(item => item.id === agent.workspaceId)?.name}</Text>
        <CompactLink label={linked.has(agent.id) ? "Unlink" : ids.has(agent.id) ? "Native or inherited worker" : "Link to this coordinator"} disabled={busy || (!linked.has(agent.id) && ids.has(agent.id))} colors={colors} onPress={() => act(agent.id, () => link({ serverId: snapshot.serverId, agentId: coordinator.agentId, remoteServerId: coordinator.remoteServerId, remoteAgentId: agent.id, remoteWorkspaceId: agent.workspaceId!, taskId: agent.labels["mission-control.task-id"] ?? host?.snapshot?.tasks.find(entry => entry.run?.agentId === agent.id)?.task.taskId ?? null, linked: !linked.has(agent.id) }))} />
      </View>)}
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Up to 50 matches shown. Narrow your search for older workers.</Text>
    </View> : null}
  </View>;
}

export function OrchestratorFleet({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const [viewportWidth, setViewportWidth] = useState(1200);
  const colors = theme.colors; const compact = layout.compact || viewportWidth < 900;
  const read = useRpc(readFleet); const queue = useRpc(setFleetQueue); const pause = useRpc(pauseFleet); const check = useRpc(reconcileFleet);
  const cache = useQueryClient(); const key = ["mission-control", "fleet", host.id];
  const query = useQuery({ queryKey: key, queryFn: () => read({ refresh: true }), refetchInterval: 20_000, retry: false });
  const snapshot = query.data;
  const [view, setView] = usePageState<ViewName>(`fleet:${host.id}:view`, "Overview");
  const [filterHost, setFilterHost] = usePageState(`fleet:${host.id}:host`, "all");
  const [filterChat, setFilterChat] = usePageState(`fleet:${host.id}:chat`, "all");
  const [selection, setSelection] = usePageState<Selection>(`fleet:${host.id}:selection`, null);
  const [search, setSearch] = usePageState(`fleet:${host.id}:search`, ""); const [stage, setStage] = usePageState(`fleet:${host.id}:stage`, "All stages");
  const [showWarnings, setShowWarnings] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(900);
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const [lastVisit, setLastVisit] = usePageState<string | null>(`fleet:${host.id}:visited`, null);
  const since = useRef(lastVisit); const marked = useRef(false);
  useEffect(() => { if (snapshot && !marked.current) { marked.current = true; setLastVisit(new Date().toISOString()); } }, [snapshot, setLastVisit]);
  function act(id: string, work: () => Promise<unknown>) {
    if (busy) return; setBusy(id); setError(null);
    void work().catch(cause => setError(problem(cause))).finally(() => { setBusy(null); void cache.invalidateQueries({ queryKey: key }); });
  }
  const openAgent = (serverId: string, agentId: string) => {
    try {
      if (!navigation) throw new Error("Conversation navigation is unavailable here.");
      const coordinator = selected?.coordinator ?? snapshot?.coordinators.find(item => serverId === host.id ? item.agentId === agentId : item.remoteServerId === serverId && managedWorkerIds(host.id, item, snapshot.hosts.find(remote => remote.serverId === serverId)?.snapshot?.agents ?? []).has(agentId));
      const navigate = () => navigation.openAgent({ serverId, agentId });
      if (coordinator) navigateWithCoordinatorReturn({ version: 1, kind: "fleet", serverId: host.id, agentId: coordinator.agentId, workspaceId: "", label: `${coordinator.hostLabel} · Orchestrator console` }, navigate);
      else navigate();
    }
    catch (cause) { setError(problem(cause)); }
  };
  const coordinators = snapshot?.coordinators.filter(item => (filterHost === "all" || item.remoteServerId === filterHost) && (filterChat === "all" || item.agentId === filterChat)) ?? [];
  const rows = coordinators.flatMap(coordinator => {
    const remote = snapshot!.hosts.find(item => item.serverId === coordinator.remoteServerId)?.snapshot;
    if (!remote) return [];
    const ids = managedWorkerIds(snapshot!.serverId, coordinator, remote.agents);
    return managedTasks(snapshot!.serverId, coordinator, remote).map(entry => {
      const workers = taskWorkers(entry, remote, ids, coordinator.links);
      return { coordinator, host: remote, entry, workers, workflow: taskWorkflow(entry, workers), queued: snapshot!.state.queue.find(item => item.coordinatorId === coordinator.agentId && item.remoteServerId === remote.serverId && item.taskId === entry.task.taskId) };
    });
  }).sort((a, b) => (b.entry.run?.updatedAt ?? b.entry.task.updatedAt).localeCompare(a.entry.run?.updatedAt ?? a.entry.task.updatedAt));
  const selected = selection ? rows.find(item => item.coordinator.agentId === selection.coordinatorId && item.entry.task.taskId === selection.taskId) : undefined;
  const visible = rows.filter(row => `${row.entry.task.title} ${row.coordinator.hostLabel} ${row.coordinator.name}`.toLowerCase().includes(search.toLowerCase()) && (stage === "All stages" || row.workflow.stage === stage)
    && (view === "Plans" ? hasOpenPlan(row.entry) : view === "Needs you" ? row.workflow.actor === "you" || row.workflow.actor === "dependency" : view === "Review" ? ["Code review", "Your review", "Delivery approval"].includes(row.workflow.stage) : view === "Work queue" ? row.queued?.enabled : stage === "Delivered" || row.workflow.actor !== "done"));
  const decisionTasks = view === "Needs you" ? visible : [];
  const decisionIndex = decisionTasks.findIndex(row => row === selected);
  const nextDecisionTask = decisionTasks.slice(decisionIndex + 1).find(row => row !== selected) ?? decisionTasks.find(row => row !== selected);
  function openDecisionTask(row: typeof rows[number]) {
    const tab = row.workflow.stage === "Delivery approval" && !row.entry.decisions.some(item => item.decision.status === "open") && !row.entry.questions.some(item => item.question.status === "open") && !row.workers.some(item => item.pendingPermissions > 0) ? "Delivery" : "Needs you";
    pageMemory.write(taskTabKey(row.host.serverId, row.coordinator.agentId, row.entry.task.taskId), tab);
    setSelection({ coordinatorId: row.coordinator.agentId, taskId: row.entry.task.taskId });
  }
  const events = snapshot?.state.events.filter(event => (filterHost === "all" || event.remoteServerId === filterHost) && (filterChat === "all" || event.coordinatorId === filterChat)) ?? [];
  const newEvents = since.current ? events.filter(event => event.at > since.current!) : [];
  const hostIssues = snapshot?.hosts.filter(remote => (filterHost === "all" || filterHost === remote.serverId) && (remote.error || remote.snapshot?.warnings.length)) ?? [];
  const unavailableHosts = hostIssues.filter(remote => remote.error);
  const limitedHosts = hostIssues.filter(remote => !remote.error);
  const card = { backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 9, padding: 16, gap: 10 };
  return <PageScrollView memoryKey={pageKey("fleet-scroll", host.id, selection?.coordinatorId ?? view, selection?.taskId ?? filterHost, filterChat)} onLayout={event => { setViewportHeight(event.nativeEvent.layout.height); setViewportWidth(event.nativeEvent.layout.width); }} style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: compact ? 14 : 24, gap: selected ? 10 : 18 }}>
    {!selected ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
      <View style={{ flex: 1, minWidth: 200, gap: 5 }}><Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 28, fontWeight: "700" }}>Orchestrator</Text><Text style={{ color: colors.foregroundMuted }}>Your coordinators, remote workers, and next decisions.</Text></View>
      <CompactLink label={query.isFetching ? "Refreshing…" : "Refresh"} colors={colors} disabled={query.isFetching} onPress={() => void query.refetch()} />
      {snapshot ? <CompactLink label={snapshot.state.paused ? "Resume enrolled coordinators" : "Pause all wake-ups"} colors={colors} disabled={Boolean(busy) || query.isError} onPress={() => act("pause", () => pause({ paused: !snapshot.state.paused, expectedRevision: snapshot.state.revision }))} /> : null}
    </View> : null}
    {error || query.isError ? <Text accessibilityRole="alert" selectable style={{ color: colors.statusDanger }}>{error ?? `Fleet refresh failed. Displayed data may be stale: ${problem(query.error)}`}</Text> : null}
    {query.isPending ? <Text style={{ color: colors.foregroundMuted }}>Reading coordinators and their remote hosts…</Text> : null}
    {snapshot ? <>
      {!selected ? <>
      <Text style={{ color: snapshot.state.paused ? colors.statusWarning : colors.foregroundMuted, fontSize: 12 }}>{snapshot.state.paused ? "Wake-ups paused" : `${snapshot.state.coordinators.filter(item => item.enabled).length} coordinators enrolled`} · Observed {date(snapshot.observedAt)} · Runs while the coordinator daemon is awake</Text>
      <Text style={{ color: snapshot.heartbeat.error ? colors.statusWarning : colors.foregroundMuted, fontSize: 12 }}>Supervisor checked {date(snapshot.heartbeat.checkedAt)}{snapshot.heartbeat.error ? ` · ${snapshot.heartbeat.error}` : ""}</Text>
      {snapshot.warnings.map(warning => <Text key={warning} style={{ color: colors.statusWarning }}>{warning}</Text>)}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{(["Overview", "Work queue", "Needs you", "Plans", "Review", "Activity", "Supervisor"] as const).map(name => <CompactLink key={name} label={name === "Needs you" ? `${name} · ${rows.filter(row => row.workflow.actor === "you" || row.workflow.actor === "dependency").length}` : name === "Plans" ? `Plans · ${rows.filter(row => hasOpenPlan(row.entry)).length}` : name} selected={view === name} colors={colors} onPress={() => { setView(name); setStage("All stages"); setSelection(null); }} />)}</View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><CompactLink label="All managed hosts" selected={filterHost === "all"} colors={colors} onPress={() => { setFilterHost("all"); setFilterChat("all"); setSelection(null); }} />{[...snapshot.hosts].sort((a, b) => a.label.localeCompare(b.label) || a.serverId.localeCompare(b.serverId)).map(remote => <CompactLink key={remote.serverId} label={`${remote.label}${remote.error ? " · unavailable" : ""}`} selected={filterHost === remote.serverId} colors={colors} onPress={() => { setFilterHost(remote.serverId); setFilterChat("all"); setSelection(null); }} />)}</View>
      {filterHost !== "all" ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><CompactLink label="All coordinators" selected={filterChat === "all"} colors={colors} onPress={() => { setFilterChat("all"); setSelection(null); }} />{snapshot.coordinators.filter(item => item.remoteServerId === filterHost).map(item => <CompactLink key={item.agentId} label={item.name} selected={filterChat === item.agentId} colors={colors} onPress={() => { setFilterChat(item.agentId); setSelection(null); }} />)}</View> : null}
      {hostIssues.length ? <View style={{ ...card, padding: 12 }}>
        <CompactLink label={`${unavailableHosts.length} unavailable · ${limitedHosts.length} with limited data · ${showWarnings ? "Hide details" : "Show details"}`} expanded={showWarnings} colors={colors} onPress={() => setShowWarnings(!showWarnings)} />
        <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{unavailableHosts.length ? `Work on ${unavailableHosts.map(remote => remote.label).join(", ")} is unknown. ` : ""}Automatic dispatch waits on affected hosts.</Text>
        {showWarnings ? hostIssues.map(remote => <View key={remote.serverId} style={{ gap: 5 }}>
          <Text style={{ color: colors.statusWarning, fontWeight: "600" }}>{remote.label} · {remote.error ? "unavailable" : "limited data"}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{remote.error ? "Reconnect this host to see its work." : "Work is visible. Update its Mission Control plugin for a complete snapshot."}</Text>
          {remote.error ? <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{remote.error}</Text> : remote.snapshot!.warnings.map((warning, index) => <Text key={index} style={{ color: colors.foregroundMuted, fontSize: 12 }}>{warning}</Text>)}
        </View>) : null}
      </View> : null}
      {filterHost !== "all" && !coordinators.length ? <Text style={{ color: colors.foregroundMuted }}>No active coordinator chat was found in this host folder. Open its orchestrator workspace to create or resume one.</Text> : null}
      {!snapshot.coordinators.length ? <View style={card}><Text style={{ color: colors.foreground }}>No orchestrator chats were found on this installation.</Text><Text style={{ color: colors.foregroundMuted }}>Open this screen on the computer hosting your orchestrator folders. Coordinators are chats in workspaces with a valid host.json binding; helpers in the same workspace are excluded. Existing remote chats are included through native parent links or explicit worker links.</Text></View> : null}
      </> : null}
      {selection && !selected ? <View style={card}><Text style={{ color: colors.statusWarning }}>The selected task is no longer available in this scope. Its host may be offline or its ownership may have changed.</Text><CompactLink label="Back to fleet" colors={colors} onPress={() => setSelection(null)} /></View> : null}
      {selected ? <FleetTaskDetail key={`${selected.coordinator.agentId}:${selected.entry.task.taskId}`} {...selected} localServerId={snapshot.serverId} colors={colors} compact={compact} navigation={navigation} nextDecisionTask={nextDecisionTask ? () => openDecisionTask(nextDecisionTask) : undefined} reviewHeight={Math.max(compact ? 640 : 800, viewportHeight - 250)} openAgent={openAgent} close={() => setSelection(null)} /> : !selection ? <>
        {view === "Overview" ? <View style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>{[["Working now", rows.filter(row => row.workers.some(agent => agent.status === "running")).length], ["Needs you", rows.filter(row => row.workflow.actor === "you").length], ["Queued", rows.filter(row => row.queued?.enabled).length]].map(([label, count]) => <View key={label} style={{ ...card, flex: 1, minWidth: 150 }}><Text style={{ color: colors.foregroundMuted }}>{label}</Text><Text style={{ color: colors.foreground, fontSize: 28, fontWeight: "700" }}>{count}</Text></View>)}</View>
          <View style={card}><Text style={{ color: colors.foreground, fontWeight: "600" }}>Since your last visit</Text><Text style={{ color: colors.foregroundMuted }}>{since.current ? `${newEvents.length} recorded changes since ${date(since.current)}` : "This visit establishes your activity baseline."}</Text>{newEvents.slice(0, 3).map(event => <Text key={event.id} style={{ color: colors.foregroundMuted, fontSize: 12 }}>{event.message} · {date(event.at)}</Text>)}</View>
        </View> : null}
        {view === "Supervisor" ? <View style={{ gap: 14 }}><View style={card}><Text style={{ color: colors.foreground }}>Automatic work is opt-in per coordinator and per task.</Text><Text style={{ color: colors.foregroundMuted }}>Checks run every 30 seconds, with each coordinator's own interval and daily wake-up limit. A manually stopped agent stays stopped. Unconfirmed sends are never blindly retried. No catch-up burst after downtime.</Text><CompactLink label="Check eligible work now" colors={colors} disabled={Boolean(busy)} onPress={() => act("check", () => check({}))} /></View>{coordinators.map(coordinator => <CoordinatorSettings key={coordinator.agentId} coordinator={coordinator} snapshot={snapshot} colors={colors} act={act} busy={Boolean(busy) || query.isError} openAgent={openAgent} />)}</View> : null}
        {view === "Activity" ? <View style={{ gap: 10 }}><Text style={{ color: colors.foregroundMuted }}>Latest 500 supervisor and workflow events are retained. Workflow updates describe recorded evidence.</Text>{!events.length ? <Text style={{ color: colors.foregroundMuted }}>No activity recorded yet.</Text> : null}{events.map(event => <View key={event.id} style={card}><Text style={{ color: event.kind === "blocked" ? colors.statusWarning : colors.foreground }}>{event.message}</Text><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{date(event.at)} · {event.kind} · {snapshot.hosts.find(host => host.serverId === event.remoteServerId)?.label ?? "Fleet"}</Text>{event.taskId && event.coordinatorId ? <CompactLink label="Open task" colors={colors} onPress={() => setSelection({ coordinatorId: event.coordinatorId!, taskId: event.taskId! })} /> : null}</View>)}</View> : null}
        {view !== "Activity" && view !== "Supervisor" ? <View style={{ gap: 12 }}>
          <TextInput accessibilityLabel="Find managed tasks" value={search} onChangeText={setSearch} placeholder="Find a task, coordinator, or host" placeholderTextColor={colors.foregroundMuted} style={{ color: colors.foreground, backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 7, padding: 12 }} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{["All stages", ...workflowStages, "Blocked"].map(name => <CompactLink key={name} label={name} colors={colors} selected={stage === name} onPress={() => setStage(name)} />)}</View>
          {view === "Needs you" ? <View style={card}><Text style={{ color: colors.foreground, fontWeight: "600" }}>Work through your decisions</Text><Text style={{ color: colors.foregroundMuted }}>Read each request, inspect its plan or code, then choose an action. Plan approval, code acceptance, and delivery approval are separate steps. You can skip ahead without answering.</Text>{decisionTasks[0] ? <CompactLink label={`Start decisions · ${decisionTasks.length} tasks`} colors={colors} onPress={() => openDecisionTask(decisionTasks[0])} /> : null}</View> : null}
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Newest workflow update first. Only tasks belonging to the selected coordinators appear.</Text>
          {!visible.length ? <View style={card}><Text style={{ color: colors.foreground }}>No matching managed tasks.</Text><Text style={{ color: colors.foregroundMuted }}>{view === "Work queue" ? "Add specific tasks to automatic work from Overview. Queuing still waits for plan, review, and delivery approvals." : "Use Supervisor → Link existing workers for older work. New native children and saved Mission Control worker links are included automatically."}</Text></View> : null}
          {visible.slice(0, 100).map(row => <View key={`${row.coordinator.agentId}:${row.entry.task.taskId}`} style={{ ...card, borderLeftWidth: 3, borderLeftColor: row.workflow.actor === "you" ? colors.statusWarning : row.workers.some(agent => agent.status === "running") ? colors.accent : colors.border }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}><Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600", flex: 1, minWidth: 200 }}>{row.entry.task.title}</Text><Text style={{ color: row.workflow.actor === "you" ? colors.statusWarning : colors.accent }}>{row.workflow.stage}</Text></View>
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{row.coordinator.hostLabel} · {row.coordinator.name} · {row.workers.length} managed workers · {date(row.entry.run?.updatedAt ?? row.entry.task.updatedAt)}</Text>
            <Text style={{ color: colors.foreground }}>{hasOpenPlan(row.entry) ? `Plan waiting for your approval${row.workflow.stage === "Blocked" ? " · other requests are under Needs you" : ""}` : row.workflow.next}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <CompactLink label={view === "Needs you" ? "Review decisions" : taskDestination(row.entry, row.workers).label} colors={colors} onPress={() => { if (view === "Needs you") { openDecisionTask(row); return; } pageMemory.write(taskTabKey(row.host.serverId, row.coordinator.agentId, row.entry.task.taskId), taskDestination(row.entry, row.workers).tab); setSelection({ coordinatorId: row.coordinator.agentId, taskId: row.entry.task.taskId }); }} />
              <CompactLink label="Open coordinator" colors={colors} onPress={() => openAgent(snapshot.serverId, row.coordinator.agentId)} />
              <CompactLink label={row.queued?.enabled ? "Remove from automatic work" : "Queue for automatic work"} colors={colors} disabled={Boolean(busy) || query.isError || row.workflow.actor === "done"} onPress={() => act(row.entry.task.taskId, () => queue({ coordinatorId: row.coordinator.agentId, remoteServerId: row.host.serverId, taskId: row.entry.task.taskId, enabled: !row.queued?.enabled, priority: row.queued?.priority ?? 5, expectedRevision: snapshot.state.revision }))} />
              {row.queued?.enabled ? <CompactLink label={row.queued.priority === 9 ? "Priority: high" : "Make high priority"} colors={colors} disabled={Boolean(busy) || query.isError} onPress={() => act(row.entry.task.taskId, () => queue({ ...row.queued!, priority: row.queued!.priority === 9 ? 5 : 9, expectedRevision: snapshot.state.revision }))} /> : null}
            </View>
          </View>)}
          {visible.length > 100 ? <Text style={{ color: colors.foregroundMuted }}>Showing 100 of {visible.length} tasks. Narrow the host or search.</Text> : null}
          {view === "Overview" ? coordinators.map(coordinator => {
            const remote = snapshot.hosts.find(item => item.serverId === coordinator.remoteServerId)?.snapshot;
            if (!remote) return null;
            const ids = managedWorkerIds(snapshot.serverId, coordinator, remote.agents);
            const workers = remote.agents.filter(agent => ids.has(agent.id));
            return <View key={coordinator.agentId} style={card}><Text style={{ color: colors.foreground, fontWeight: "600" }}>{coordinator.hostLabel} · {coordinator.name}</Text><FleetWorkerTree workers={workers.slice(0, 20)} serverId={remote.serverId} colors={colors} openAgent={openAgent} />{workers.length > 20 ? <Text style={{ color: colors.foregroundMuted }}>Showing 20 of {workers.length} managed workers.</Text> : null}</View>;
          }) : null}
        </View> : null}
      </> : null}
    </> : null}
  </PageScrollView>;
}

export function registerFleetClient(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: fleetScreenId, title: "Orchestrator", Component: OrchestratorFleet }),
    client.addSidebarHeaderItem({ id: fleetScreenId, title: "Orchestrator", Component: ({ currentScreen, openScreen }) => <SidebarRow icon="Network" active={currentScreen?.screenId === fleetScreenId} onPress={() => openScreen({ screenId: fleetScreenId })} /> }),
    client.addCommandCenterItem({ id: "open-orchestrator", title: "Open Orchestrator", icon: "Network", context: "global", keywords: ["fleet", "workers", "queue", "mission", "control"], onSelect: () => client.openScreen({ screenId: fleetScreenId }) }),
    client.addSlashCommand({ name: "orchestrator", description: "Open the Orchestrator console", argumentHint: "", context: "agent", onSubmit: () => client.openScreen({ screenId: fleetScreenId }) }),
  ];
  return () => removers.forEach(remove => remove());
}
