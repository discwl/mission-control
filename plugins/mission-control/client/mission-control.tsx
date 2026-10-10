import {
  useHosts,
  useRpc,
  type PluginHostSummary,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ArchiveButton } from "./archive-button";
import { RenameAll, ReviewNames } from "./review-names";
import { useDecisions } from "./needs-you";
import { MissionReview } from "./mission-review";
import { WorkspaceTerminals } from "./workspace-terminals";
import { MorningCheck } from "./morning-check";
import { Pressable, Text, TextInput, View, type ScrollView as NativeScrollView } from "react-native";
import { PageScrollView as ScrollView } from "./page-state";
import { listTasks } from "../shared/tasks";
import { getTaskSummary, hasMatchingTasks, selectTaskCounts, taskSummaryKey } from "../shared/task-summary";
import { TaskCountBadge, taskCountLabel } from "./task-count-badge";
import { togglePaseoSidebar } from "./web";
import { MissionDocs } from "./mission-docs";
import { VaultDocumentLinks } from "./document-links";
import { MissionTasksEditor } from "./workspace-tasks";
import { LinkedTasks } from "./linked-tasks";
import { InfoTip } from "./info-tip";
import { HostList } from "./host-list";
import { formatDateTime } from "./date-time";
import { pageKey } from "./page-memory";
import { usePageState } from "./page-state";
import { filterWorkspaceEntries } from "./workspace-filters";
import { WorkspaceFilterBar } from "./workspace-filter-bar";
import { ProjectHeader } from "./project-header";
import { ProjectList, type ProjectScrollState } from "./project-list";
import { useCollapsedProjects } from "./project-collapse";
import { projectCollapseKey, summarizeProjectAgents } from "./project-summary";
import { ProjectGit } from "./project-git";
import { Attention, pendingPrompts, useWaitingCount } from "./attention";
import { useMergeReady } from "./merge-action";
import { TaskProblems } from "./task-problems";
import { contextLineFor, rosterQuery, type Project, type Roster } from "./roster";
import { useTaskTitles } from "./subagents";
import { AgentTree, treeSummaryLine } from "./agent-tree";

type Colors = PluginSurfaceProps["theme"]["colors"];
type Selection = { serverId: string; workspaceId: string };

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const issues: unknown = JSON.parse(message);
    if (Array.isArray(issues) && issues.length > 0) {
      const first: unknown = issues[0];
      if (first && typeof first === "object" && "message" in first && typeof first.message === "string") {
        return first.message;
      }
    }
  } catch {
    // Other SDK errors already carry readable messages.
  }
  return message.length > 180 ? `${message.slice(0, 180)}…` : message;
}

function timeLabel(value: string | null): string {
  if (!value) return "No activity timestamp";
  return formatDateTime(value);
}

function hostStatusColor(status: PluginHostSummary["status"], colors: Colors): string {
  if (status === "online") return colors.statusSuccess;
  if (status === "error") return colors.statusDanger;
  return colors.statusWarning;
}

function workspaceStatusColor(status: string, colors: Colors): string {
  if (status === "running") return colors.statusSuccess;
  if (status === "failed") return colors.statusDanger;
  if (status === "attention" || status === "needs_input") return colors.statusWarning;
  return colors.foregroundMuted;
}

function projectsWithWorkspaces(roster: Roster): Project[] {
  const projects = new Map(roster.projects.map((project) => [project.id, project]));
  for (const workspace of roster.workspaces) {
    if (!projects.has(workspace.projectId)) {
      projects.set(workspace.projectId, { id: workspace.projectId, name: workspace.projectName });
    }
  }
  return [...projects.values()].filter((project) =>
    roster.workspaces.some((workspace) => workspace.projectId === project.id),
  );
}

const statusLabels = ["Ready", "In Progress", "Review", "Blocked", "Paused", "Done"];

function LabelBadge({ name, colors }: { name: string; colors: Colors }) {
  return <View accessibilityLabel={`Workspace label ${name}`} style={{ borderColor: colors.border, borderWidth: 1, borderRadius: 5, backgroundColor: colors.surface2, paddingHorizontal: 6, paddingVertical: 3 }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{name}</Text>
  </View>;
}

function FilterChip({ label, active, onPress, colors }: { label: string; active: boolean; onPress: () => void; colors: Colors }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress}
      style={{ borderColor: active ? colors.accent : colors.border, borderWidth: 1, borderRadius: 6, backgroundColor: active ? colors.surface2 : colors.surface1, paddingHorizontal: 10, height: 44, alignSelf: "center", justifyContent: "center" }}>
      <Text style={{ color: active ? colors.foreground : colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

export function MissionControl({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const hosts = useHosts();
  const scope = pageKey(host.id, "surface");
  const [activeHostId, setActiveHostId] = usePageState<string | null>(`${scope}:host`, null);
  const [selection, setSelection] = usePageState<Selection | null>(`${scope}:workspace`, null);
  const [hostSearch, setHostSearch] = usePageState(`${scope}:host-search`, "");
  const [onlineHostsOnly, setOnlineHostsOnly] = usePageState(`${scope}:online`, false);
  const [workspaceSearch, setWorkspaceSearch] = usePageState(`${scope}:workspace-search`, "");
  const [projectFilter, setProjectFilter] = usePageState<string[]>(`${scope}:projects`, []);
  const [labelFilter, setLabelFilter] = usePageState(`${scope}:label`, "all");
  const [workspaceFilter, setWorkspaceFilter] = usePageState<"all" | "active" | "attention" | "tasks" | "active_tasks">(`${scope}:workspace-filter`, "all");
  const [view, setView] = usePageState<"workspaces" | "attention" | "tasks" | "docs" | "review">(`${scope}:view`, "workspaces");
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [agentsHeadingWidth, setAgentsHeadingWidth] = useState(0);
  const [workspacePickerOpen, setWorkspacePickerOpen] = usePageState(`${scope}:picker`, false);
  const [workspaceOpen, setWorkspaceOpen] = usePageState(`${scope}:workspace-open`, false);
  const [documentTaskId, setDocumentTaskId] = useState<string | null>(null);
  const [documentRequest, setDocumentRequest] = useState<{ path: string; requestId: number } | null>(null);
  const [documentSequence, setDocumentSequence] = useState(0);
  const collapsedProjects = useCollapsedProjects();
  const fullWorkspaceView = view === "tasks" || view === "docs" || view === "review";
  const rosters = useQueries({ queries: hosts.map((host) => rosterQuery(host.serverId, host.status === "online")) });

  const readTaskSummary = useRpc(getTaskSummary);
  const taskOwnerOnline = hosts.some(candidate => candidate.serverId === host.id && candidate.status === "online");
  const summaryQuery = useQuery({
    queryKey: taskSummaryKey(host.id),
    queryFn: () => readTaskSummary({ serverId: host.id }),
    enabled: taskOwnerOnline,
    staleTime: 10_000,
    refetchInterval: taskOwnerOnline ? 20_000 : false,
    retry: false,
  });
  // useRpc is installation-scoped. Never present this vault's counts on another host.
  const taskSummary = taskOwnerOnline && !summaryQuery.isError ? summaryQuery.data : undefined;
  function taskCountPlaceholder(serverId: string) {
    if (hosts.find(candidate => candidate.serverId === serverId)?.status !== "online") return "Tasks offline";
    if (serverId !== host.id) return "Tasks unavailable";
    return summaryQuery.isError ? "Task count error" : "Loading tasks…";
  }

  const colors = theme.colors;
  const compact = layout.compact;
  const projectScroll = useRef<NativeScrollView>(null);
  const compactScroll = useRef<NativeScrollView>(null);
  const projectScrollState = useRef<ProjectScrollState>({ offset: 0, height: 0, contentHeight: 0 });
  const compactScrollState = useRef<ProjectScrollState>({ offset: 0, height: 0, contentHeight: 0 });
  const decisionsQuery = useDecisions(host.id, taskOwnerOnline);
  const openDecisions = decisionsQuery.data?.open.length ?? 0;
  const availableHosts = hosts.filter((host) => !onlineHostsOnly || host.status === "online");
  const defaultHostId = availableHosts.find((host) => host.label.toLowerCase() === "personal")?.serverId ?? availableHosts[0]?.serverId;
  const currentHostId = availableHosts.some((host) => host.serverId === activeHostId) ? activeHostId : defaultHostId;
  const activeHostIndex = hosts.findIndex((host) => host.serverId === currentHostId);
  const activeHost = activeHostIndex >= 0 ? hosts[activeHostIndex] : null;
  const activeQuery = activeHostIndex >= 0 ? rosters[activeHostIndex] : null;
  const activeRoster = activeQuery?.data;
  const labelNames = new Map<string, string>();
  for (const name of [...statusLabels, ...(activeRoster?.workspaces.flatMap(workspace => workspace.labels) ?? []), ...(labelFilter === "all" ? [] : [labelFilter])]) {
    const key = name.trim().toLowerCase();
    if (key && !labelNames.has(key)) labelNames.set(key, name);
  }
  const availableLabels = [...labelNames.values()];
  const selectedHostIndex = selection ? hosts.findIndex((host) => host.serverId === selection.serverId) : -1;
  const selectedHost = selectedHostIndex >= 0 ? hosts[selectedHostIndex] : null;
  const selectedRoster = selectedHostIndex >= 0 ? rosters[selectedHostIndex]?.data : null;
  const selectedWorkspace = selectedRoster?.workspaces.find((workspace) => workspace.id === selection?.workspaceId);
  const selectedAgents = (selectedRoster?.agents.filter((agent) => agent.workspaceId === selectedWorkspace?.id) ?? [])
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  // Task titles for sub-agents' context lines come from this Mission Control's vault, whichever host the workspace is on.
  const taskTitles = useTaskTitles(host.id, host.id);
  const readTasks = useRpc(listTasks);
  const taskWorkspaceId = selectedWorkspace?.id ?? "";
  const taskQuery = useQuery({
    queryKey: ["mission-control", "tasks", host.id, taskWorkspaceId],
    queryFn: () => readTasks({ serverId: host.id, workspaceId: taskWorkspaceId }),
    enabled: taskWorkspaceId.length > 0 && selectedHost?.serverId === host.id,
    retry: false,
  });
  const canNavigate = selectedHost?.status === "online" && navigation !== undefined;
  const visibleHosts = hosts.filter((host) =>
    (!onlineHostsOnly || host.status === "online") && host.label.toLowerCase().includes(hostSearch.trim().toLowerCase()),
  );
  const visibleWorkspaces = filterWorkspaceEntries(activeRoster?.workspaces ?? [], { search: workspaceSearch, projectIds: projectFilter, label: labelFilter }, workspace => {
    if (workspaceFilter === "tasks" || workspaceFilter === "active_tasks") return hasMatchingTasks(selectTaskCounts(taskSummary, currentHostId ?? "", { workspaceId: workspace.id }), workspaceFilter === "active_tasks");
    if (workspaceFilter === "attention") return activeRoster?.agents.some(agent => agent.workspaceId === workspace.id && agent.requiresAttention) ?? false;
    if (workspaceFilter === "active") return activeRoster?.agents.some(agent => agent.workspaceId === workspace.id && agent.status === "running") ?? false;
    return true;
  });
  const visibleProjects = activeRoster ? projectsWithWorkspaces(activeRoster).filter((project) =>
    visibleWorkspaces.some((workspace) => workspace.projectId === project.id),
  ) : [];
  // Attention counts what needs you: permission prompts, questions and errors, open decisions and approved tasks to merge.
  const mergeReady = useMergeReady(host.id, taskOwnerOnline);
  const waitingCount = useWaitingCount(host.id, taskOwnerOnline, hosts, rosters);
  const attentionTotal = pendingPrompts(hosts, rosters).length + waitingCount + openDecisions + (mergeReady.data?.tasks.length ?? 0);

  function openWorkspace(serverId: string, workspaceId: string) {
    try {
      const target = { serverId, workspaceId, focusHost: true };
      navigation?.openWorkspace(target);
      setNavigationError(null);
    } catch (error) {
      setNavigationError(describeError(error));
    }
  }

  function openAgent(serverId: string, agentId: string) {
    try {
      const target = { serverId, agentId, focusHost: true };
      navigation?.openAgent(target);
      setNavigationError(null);
    } catch (error) {
      setNavigationError(describeError(error));
    }
  }

  const header = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      {layout.platform === "web" && !compact ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Toggle Paseo sidebar" onPress={togglePaseoSidebar}
          style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 7 }}>
          <Icon name="PanelLeft" size={17} color={colors.foregroundMuted} />
        </Pressable>
      ) : null}
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: colors.foreground, fontSize: compact ? 24 : 28, fontWeight: "600" }}>Mission Control</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{hosts.length} {hosts.length === 1 ? "host" : "hosts"} · live Paseo workspaces and agents</Text>
      </View>
    </View>
  );

  const hostPane = (
    <View style={{ width: compact ? "100%" : 194, minHeight: 0, backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 10, padding: 12, gap: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>Hosts</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{visibleHosts.length}/{hosts.length}</Text>
      </View>
      <TextInput accessibilityLabel="Filter hosts" placeholder="Find a host" placeholderTextColor={colors.foregroundMuted}
        value={hostSearch} onChangeText={setHostSearch}
        style={{ color: colors.foreground, backgroundColor: colors.surface0, borderColor: colors.border, borderWidth: 1, borderRadius: 7, paddingHorizontal: 9, paddingVertical: 7, fontSize: 13 }} />
      <View style={{ flexDirection: "row", gap: 6 }}>
        <FilterChip label="All hosts" active={!onlineHostsOnly} onPress={() => setOnlineHostsOnly(false)} colors={colors} />
        <FilterChip label="Online" active={onlineHostsOnly} onPress={() => { setOnlineHostsOnly(true); if (selectedHost?.status !== "online") setSelection(null); }} colors={colors} />
      </View>
      <HostList hosts={hosts} visibleHosts={visibleHosts} compact={compact} colors={colors} renderHost={(host) => {
        const index = hosts.findIndex((candidate) => candidate.serverId === host.serverId);
        const roster = rosters[index]?.data;
        const selected = host.serverId === currentHostId;
        const attentionCount = roster?.agents.filter((agent) => agent.requiresAttention).length ?? 0;
        return <Pressable accessibilityRole="button" accessibilityLabel={`Show ${host.label} workspaces`}
          onPress={() => { setActiveHostId(host.serverId); setSelection(null); setWorkspaceOpen(false); setDocumentTaskId(null); setProjectFilter([]); if (!fullWorkspaceView) setView("workspaces"); }}
          style={{ flex: 1, minWidth: 0, backgroundColor: selected ? colors.surface2 : colors.surface1, borderLeftColor: selected ? colors.accent : "transparent", borderLeftWidth: 2, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 9, justifyContent: "center", gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
            <Text numberOfLines={1} style={{ color: colors.foreground, fontWeight: selected ? "600" : "400", flex: 1 }}>{host.label}</Text>
            {attentionCount > 0 ? <View accessibilityLabel={`${attentionCount} agents need attention`} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}><Icon name="CircleAlert" size={12} color={colors.statusWarning} /><Text style={{ color: colors.statusWarning, fontSize: 12 }}>{attentionCount}</Text></View> : null}
          </View>
          <Text numberOfLines={1} style={{ color: hostStatusColor(host.status, colors), fontSize: 11 }}>
            {host.status}{roster ? ` · ${roster.workspaces.length} workspaces` : ""}
          </Text>
          <TaskCountBadge counts={selectTaskCounts(taskSummary, host.serverId)} unavailable={taskCountPlaceholder(host.serverId)} colors={colors} small />
        </Pressable>;
      }} />
    </View>
  );

  const pageButton = (label: string, onPress: () => void, primary = false, disabled = false) => (
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
      style={{ minHeight: 40, paddingHorizontal: 14, justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: primary && !disabled ? colors.accent : colors.border, backgroundColor: primary && !disabled ? colors.accent : "transparent", opacity: disabled ? 0.5 : 1 }}>
      <Text style={{ color: primary && !disabled ? colors.accentForeground : colors.foreground, fontWeight: primary ? "600" : "400", fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
  const localTasks = selectedHost?.serverId === host.id ? taskQuery.data?.tasks : undefined;
  const workspacePage = selectedWorkspace && selectedHost ? (
    <ScrollView memoryKey={pageKey(scope, "workspace-page", selectedHost.serverId, selectedWorkspace.id)} scrollEnabled={!compact} style={{ flex: compact ? undefined : 1, minHeight: 0 }} contentContainerStyle={{ gap: 18, paddingBottom: 12 }} nestedScrollEnabled>
      <View style={{ gap: 9 }}>
        <CompactLink label="← All workspaces" colors={colors} onPress={() => setWorkspaceOpen(false)} />
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 22, fontWeight: "700", flexShrink: 1 }}>{selectedWorkspace.name}</Text>
          <ReviewNames key={`${selectedHost.serverId}:${selectedWorkspace.id}`} host={selectedHost} taskHostId={host.id} workspace={selectedWorkspace} agents={selectedAgents.map(agent => ({ ...agent, context: selectedRoster ? contextLineFor(selectedRoster, agent, taskTitles) : null }))} colors={colors} canNavigate={canNavigate} openAgent={id => openAgent(selectedHost.serverId, id)} />
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Breadcrumbs colors={colors} segments={[selectedHost.label, selectedWorkspace.projectName, selectedWorkspace.name]} />
          <Text style={{ color: workspaceStatusColor(selectedWorkspace.status, colors), fontSize: 13 }}>· Paseo: {selectedWorkspace.status.replaceAll("_", " ")}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>· Activity: {timeLabel(selectedWorkspace.activityAt)}</Text>
          {selectedWorkspace.labels.map(name => <LabelBadge key={name.toLowerCase()} name={name} colors={colors} />)}
          <InfoTip label="About workspace labels" text="Workspace labels come from Paseo. Open the workspace in Paseo to edit them." colors={colors} />
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {pageButton("Open workspace", () => openWorkspace(selectedHost.serverId, selectedWorkspace.id), true, !canNavigate)}
          {pageButton(localTasks ? `Tasks · ${localTasks.length}` : "Tasks", () => setView("tasks"))}
          {pageButton("Review changes", () => setView("review"))}
          {pageButton("Documents", () => setView("docs"))}
          <ArchiveButton resource={{ kind: "workspace", id: selectedWorkspace.id, name: selectedWorkspace.name, serverId: selectedHost.serverId, hostLabel: selectedHost.label }} colors={colors} disabled={selectedHost.status !== "online"}
            onComplete={target => { setSelection(current => current?.serverId === target.serverId && current.workspaceId === target.id ? null : current); setWorkspaceOpen(false); }} />
        </View>
        {navigationError ? <Text style={{ color: colors.statusDanger, fontSize: 12 }}>Navigation failed: {navigationError}</Text> : null}
        {selectedHost.status !== "online" ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Host unavailable. Showing last observed data.</Text> : null}
        {!navigation ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Open actions are unavailable in this client.</Text> : null}
      </View>
      <AgentTree key={`${selectedHost.serverId}:${selectedWorkspace.id}`} serverId={selectedHost.serverId} localServerId={host.id} workspaceId={selectedWorkspace.id}
        online={selectedHost.status === "online"} colors={colors} canNavigate={canNavigate} openAgent={id => openAgent(selectedHost.serverId, id)}
        heading={(counts, { refresh, refreshing, renameAll }) => <View onLayout={event => setAgentsHeadingWidth(event.nativeEvent.layout.width)} style={{ gap: 2, zIndex: 20 }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600" }}>Agents ({counts.agents})</Text>
            <InfoTip label="About the agent tree" containerWidth={agentsHeadingWidth} text="An agent started by another agent sits under it, even when it works in another workspace. An agent from another workspace that started one here is shown dimmed. Helpers that run inside an agent's turn, such as Claude Code's Agent tool, are listed under it on the host running this Mission Control. The Agents panel in Explorer shows the same tree." colors={colors} />
            <View style={{ flex: 1 }} />
            {renameAll}
            <View style={{ alignSelf: "center" }}><CompactLink label={refreshing ? "Refreshing…" : "Refresh"} accessibilityLabel="Refresh agents" colors={colors} disabled={refreshing} onPress={refresh} /></View>
          </View>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{treeSummaryLine(counts)}</Text>
        </View>} />
      <WorkspaceTerminals key={`${selectedHost.serverId}:${selectedWorkspace.id}`} host={selectedHost} workspaceId={selectedWorkspace.id} colors={colors} compact={compact} />
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10, gap: 6 }}>
        {selectedHost.serverId !== host.id || !taskQuery.data ? <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>Linked tasks</Text> : null}
        {selectedHost.serverId !== host.id ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Vault tasks for this host require its own adapter.</Text> : <>
          {taskQuery.isPending ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Loading vault tasks…</Text> : null}
          {taskQuery.isError ? <Text style={{ color: colors.statusDanger, fontSize: 12 }}>Vault error: {describeError(taskQuery.error)}</Text> : null}
          <TaskProblems problems={taskQuery.data?.problems} colors={colors} />
          {taskQuery.data ? <LinkedTasks key={`${selectedHost.serverId}:${selectedWorkspace.id}`} tasks={taskQuery.data.tasks} colors={colors}
            serverId={selectedHost.serverId} workspaceId={selectedWorkspace.id} hostLabel={selectedHost.label} online={selectedHost.status === "online"}
            openAgent={id => { if (canNavigate) openAgent(selectedHost.serverId, id); }} viewAll={() => { setWorkspacePickerOpen(false); setView("tasks"); }} /> : null}
          <ProjectGit projectId={selectedWorkspace.projectId} projectName={selectedWorkspace.projectName} local={selectedHost.serverId === host.id && selectedHost.status === "online"} colors={colors} />
          {!taskQuery.data ? <CompactLink label="View all tasks" colors={colors} onPress={() => setView("tasks")} /> : null}
        </>}
      </View>
      <MorningCheck key={`${selectedHost.serverId}:${selectedWorkspace.id}`} ownServerId={host.id} host={selectedHost} workspace={selectedWorkspace} colors={colors} navigation={navigation} />
    </ScrollView>
  ) : null;
  const workspacePane = (
    <View style={{ flex: compact ? undefined : 1, minWidth: 0, minHeight: 0, backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 10, padding: 14, gap: 11 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: compact ? 10 : 16, borderBottomColor: colors.border, borderBottomWidth: 1, paddingBottom: 9 }}>
        {(["workspaces", "attention", "tasks", "review", "docs"] as const).map((tab) => {
          const selected = view === tab;
          return <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => { setView(tab); setWorkspacePickerOpen(false); if (tab === "docs") setDocumentTaskId(null); }} style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={{ color: selected ? colors.accent : colors.foregroundMuted, fontWeight: selected ? "600" : "400" }}>
              {tab === "attention" ? `Attention${attentionTotal ? ` (${attentionTotal})` : ""}` : tab === "workspaces" ? "Workspaces" : tab === "tasks" ? "Tasks" : tab === "review" ? "Review" : "Docs"}
            </Text>
          </Pressable>;
        })}
      </View>
      {view === "workspaces" && workspaceOpen && workspacePage ? workspacePage : view === "workspaces" || ((view === "tasks" || view === "review") && (!selectedWorkspace || workspacePickerOpen)) ? (
        <>
          <View style={{ gap: 7 }}>
            <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "600" }}>{fullWorkspaceView ? `Choose a workspace for ${view} · ` : ""}{activeHost?.label ?? "No host selected"}</Text>
            {activeHost ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <TaskCountBadge presentation="toolbar" counts={selectTaskCounts(taskSummary, activeHost.serverId)} unavailable={taskCountPlaceholder(activeHost.serverId)} colors={colors} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
              {view === "workspaces" && activeRoster ? <RenameAll key={activeHost.serverId} host={activeHost} taskHostId={host.id} colors={colors}
                workspaces={visibleWorkspaces.map(workspace => ({ ...workspace, agents: activeRoster.agents.filter(agent => agent.workspaceId === workspace.id).map(agent => ({ ...agent, context: contextLineFor(activeRoster, agent, taskTitles) })) }))} /> : null}
              {activeHost.serverId === host.id && activeHost.status === "online" ? <CompactLink iconOnly icon="RefreshCw" label="Refresh counts" accessibilityLabel="Refresh task counts" colors={colors} disabled={summaryQuery.isFetching} onPress={() => void summaryQuery.refetch()} /> : null}
            </View>
            </View> : null}
            {activeHost?.serverId !== host.id && activeHost ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Task counts are unavailable here for {activeHost.label}. Open Mission Control on that host to view its vault tasks.</Text> : null}
            {activeHost?.serverId === host.id && summaryQuery.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning, fontSize: 12 }}>Could not read task counts: {describeError(summaryQuery.error)}</Text> : null}
            {activeHost?.serverId === host.id ? <TaskProblems problems={taskSummary?.problems} colors={colors} /> : null}
            {fullWorkspaceView && selectedWorkspace ? <CompactLink label={`← Back to ${view}`} colors={colors} onPress={() => setWorkspacePickerOpen(false)} /> : null}
            <WorkspaceFilterBar key={currentHostId} colors={colors} search={workspaceSearch} onSearch={setWorkspaceSearch} show={workspaceFilter} onShow={setWorkspaceFilter}
              label={labelFilter} labels={availableLabels} onLabel={setLabelFilter}
              projectIds={projectFilter} projects={activeRoster && (projectsWithWorkspaces(activeRoster).length > 1 || projectFilter.length > 0) ? projectsWithWorkspaces(activeRoster) : null} onProjects={setProjectFilter}
              shown={visibleWorkspaces.length} total={activeRoster?.workspaces.length ?? 0}
              actions={visibleProjects.length > 0 ? <>
                <CompactLink label="Expand all" colors={colors} onPress={() => collapsedProjects.setAll(visibleProjects.map(project => projectCollapseKey(currentHostId ?? "", project.id)), false)} />
                <CompactLink label="Collapse all" colors={colors} onPress={() => collapsedProjects.setAll(visibleProjects.map(project => projectCollapseKey(currentHostId ?? "", project.id)), true)} />
              </> : null} />
            {collapsedProjects.error ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <Text accessibilityRole="alert" style={{ color: colors.statusWarning, fontSize: 12, flexShrink: 1 }}>{collapsedProjects.error}</Text>
              <CompactLink label="Reload layout" colors={colors} onPress={collapsedProjects.reload} />
            </View> : null}
          </View>
          <ScrollView scrollRef={projectScroll} memoryKey={pageKey(scope, view, currentHostId ?? "", workspaceSearch, JSON.stringify(projectFilter), workspaceFilter, labelFilter)} scrollEnabled={!compact}
            onLayout={event => { projectScrollState.current.height = event.nativeEvent.layout.height; }}
            onContentSizeChange={(_width, height) => { projectScrollState.current.contentHeight = height; }}
            onScroll={event => { projectScrollState.current.offset = event.nativeEvent.contentOffset.y; }}
            style={{ flex: compact ? undefined : 1, minHeight: 0 }} contentContainerStyle={{ gap: 10, paddingBottom: 6 }} nestedScrollEnabled>
            {!activeHost ? <Text style={{ color: colors.foregroundMuted }}>No Paseo hosts are configured in this app.</Text> : null}
            {activeHost && activeHost.status !== "online" ? <Text style={{ color: colors.statusWarning }}>Host {activeHost.status}. {activeRoster ? `Last observed ${timeLabel(activeRoster.observedAt)}.` : "Connect it to load its roster."}</Text> : null}
            {activeHost?.status === "online" && activeQuery?.isPending ? <Text style={{ color: colors.foregroundMuted }}>Loading roster…</Text> : null}
            {activeQuery?.isError ? <Text style={{ color: colors.statusDanger }}>Roster error: {describeError(activeQuery.error)}</Text> : null}
            {activeRoster?.hasMore ? <Text style={{ color: colors.statusWarning }}>More workspaces or agents exist than this view loaded.</Text> : null}
            {activeRoster && visibleWorkspaces.length === 0 ? <Text style={{ color: colors.foregroundMuted }}>{(workspaceFilter === "tasks" || workspaceFilter === "active_tasks") && !selectTaskCounts(taskSummary, currentHostId ?? "") ? "Task counts are not available for this host. Choose All to browse its workspaces." : activeRoster.workspaces.length === 0 ? "No workspaces on this host." : workspaceFilter === "tasks" ? "No workspaces with tasks match these filters." : workspaceFilter === "active_tasks" ? "No workspaces with active tasks match these filters." : "No workspaces match these filters."}</Text> : null}
            <ProjectList key={`${currentHostId}:${compact}`} serverId={currentHostId ?? ""} projects={activeRoster ? projectsWithWorkspaces(activeRoster) : []}
              visibleIds={visibleProjects.map(project => project.id)} colors={colors} scrollRef={compact ? compactScroll : projectScroll}
              scrollState={compact ? compactScrollState : projectScrollState} renderProject={(project, handle) => {
              const projectWorkspaces = visibleWorkspaces.filter((workspace) => workspace.projectId === project.id);
              const collapseKey = projectCollapseKey(currentHostId ?? "", project.id);
              const collapsed = collapsedProjects.isCollapsed(collapseKey);
              return (
              <View key={project.id} style={{ gap: 8, paddingBottom: collapsed ? 4 : 12 }}>
                <View style={{ flexDirection: "row", alignItems: "stretch", backgroundColor: colors.surface2, borderRadius: 7 }}><View style={{ flex: 1, minWidth: 0 }}><ProjectHeader name={project.name} collapsed={collapsed} onToggle={() => collapsedProjects.toggle(collapseKey)} workspaceCount={projectWorkspaces.length}
                  summary={summarizeProjectAgents(projectWorkspaces, activeRoster?.agents ?? [])} colors={colors}
                  tasks={<TaskCountBadge counts={selectTaskCounts(taskSummary, currentHostId ?? "", { projectId: project.id })} unavailable={taskCountPlaceholder(currentHostId ?? "")} colors={colors} small />}
                  tasksLabel={taskCountLabel(selectTaskCounts(taskSummary, currentHostId ?? "", { projectId: project.id }), taskCountPlaceholder(currentHostId ?? ""))} /></View>{handle}</View>
                <View style={{ paddingLeft: 30, paddingRight: 10 }}><ProjectGit projectId={project.id} projectName={project.name} local={activeHost?.serverId === host.id && activeHost.status === "online"} colors={colors} /></View>
                {!collapsed && projectWorkspaces.map((workspace) => {
                  const agents = activeRoster?.agents.filter((agent) => agent.workspaceId === workspace.id) ?? [];
                  const selected = selection?.serverId === activeHost?.serverId && selection?.workspaceId === workspace.id;
                  return (
                    <View key={workspace.id} style={{ gap: 4 }}><Pressable accessibilityRole="button" accessibilityLabel={`Open ${workspace.name} on ${activeHost?.label}`}
                      onPress={() => { if (activeHost) setSelection({ serverId: activeHost.serverId, workspaceId: workspace.id }); if (view === "workspaces") setWorkspaceOpen(true); setDocumentTaskId(null); setWorkspacePickerOpen(false); setNavigationError(null); }}
                      style={{ backgroundColor: selected ? colors.surface2 : colors.surface0, borderColor: selected ? colors.accent : colors.border, borderWidth: 1, borderRadius: 7, padding: 10, gap: 4 }}>
                      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 6 }}>
                        <Text numberOfLines={1} style={{ color: colors.foreground, fontWeight: "600", flex: 1 }}>{workspace.name}</Text>
                        <Text style={{ color: workspaceStatusColor(workspace.status, colors), fontSize: 12 }}>{workspace.status.replaceAll("_", " ")}</Text>
                      </View>
                      {workspace.labels.length > 0 ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
                        {workspace.labels.slice(0, 3).map(name => <LabelBadge key={name.toLowerCase()} name={name} colors={colors} />)}
                        {workspace.labels.length > 3 ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>+{workspace.labels.length - 3} more</Text> : null}
                      </View> : null}
                      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{agents.length} {agents.length === 1 ? "agent" : "agents"} · {timeLabel(workspace.activityAt)}</Text>
                        <TaskCountBadge counts={selectTaskCounts(taskSummary, currentHostId ?? "", { workspaceId: workspace.id })} unavailable={taskCountPlaceholder(currentHostId ?? "")} colors={colors} />
                      </View>
                    </Pressable>
                    </View>
                  );
                })}
              </View>
              );
            }} />
          </ScrollView>
        </>
      ) : view === "attention" ? (
        <Attention colors={colors} compact={compact} serverId={host.id} hosts={hosts} rosters={rosters} memory={pageKey(scope, "attention")} actions={{
          openAgent,
          openDocs: (workspaceId, taskId) => { setSelection({ serverId: host.id, workspaceId }); setDocumentTaskId(taskId); setView("docs"); },
          openReview: workspaceId => { setSelection({ serverId: host.id, workspaceId }); setWorkspacePickerOpen(false); setView("review"); },
        }} />
      ) : null}
      {view === "tasks" && selectedWorkspace && selectedHost && !workspacePickerOpen ? <View style={{ flex: compact ? undefined : 1, minHeight: 0, gap: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, borderBottomColor: colors.border, borderBottomWidth: 1, paddingBottom: 10 }}>
          <View style={{ flex: 1, minWidth: 160, gap: 3 }}><Breadcrumbs colors={colors} segments={[selectedHost.label, selectedWorkspace.projectName, selectedWorkspace.name]} /><Text numberOfLines={2} style={{ color: colors.foreground, fontWeight: "600", fontSize: 15 }}>{selectedWorkspace.name}</Text></View>
          <CompactLink label="Change workspace" colors={colors} onPress={() => setWorkspacePickerOpen(true)} />
        </View>
        {selectedHost.serverId === host.id ? <MissionTasksEditor key={selectedWorkspace.id} theme={theme} host={host} layout={layout} navigation={navigation} workspaceId={selectedWorkspace.id} workspaceName={selectedWorkspace.name} projectId={selectedWorkspace.projectId} projectName={selectedWorkspace.projectName} workspaceStatus={selectedWorkspace.status} embedded onOpenDocs={taskId => { setDocumentTaskId(taskId); setView("docs"); }} /> : <Text style={{ color: colors.foregroundMuted }}>Open Mission Control on {selectedHost.label} to access its dev-vault. This installation can only edit its own host's files.</Text>}
      </View> : null}
      {view === "review" && selectedWorkspace && selectedHost && !workspacePickerOpen ? (
        <MissionReview key={`${selectedHost.serverId}:${selectedWorkspace.id}`} serverId={selectedHost.serverId} localServerId={host.id} online={selectedHost.status === "online"} colors={colors} compact={compact}
          workspace={{ id: selectedWorkspace.id, name: selectedWorkspace.name, projectName: selectedWorkspace.projectName, hostLabel: selectedHost.label }}
          onChangeWorkspace={() => setWorkspacePickerOpen(true)} />
      ) : null}
      {view === "docs" ? <MissionDocs key={host.id} theme={theme} host={host} hostLabel={hosts.find(candidate => candidate.serverId === host.id)?.label ?? host.id} layout={layout} initialTaskId={documentTaskId} initialDocument={documentTaskId ? null : documentRequest} onDocumentHandled={() => setDocumentRequest(null)} /> : null}
    </View>
  );

  const body = (
    <View style={{ flex: compact ? undefined : 1, minHeight: 0, flexDirection: compact ? "column" : "row", gap: 12 }}>
      {view !== "docs" && view !== "attention" && !(view === "review" && selectedWorkspace && !workspacePickerOpen) && !(compact && view === "workspaces" && workspaceOpen && selectedWorkspace) && (!compact || hosts.length > 1) && (!compact || !fullWorkspaceView || workspacePickerOpen || !selectedWorkspace) ? hostPane : null}
      {workspacePane}
    </View>
  );
  return <VaultDocumentLinks serverId={host.id} scope={`${host.id}:${selection?.serverId ?? ""}:${selection?.workspaceId ?? ""}:${view}`} onOpen={path => {
    setDocumentTaskId(null); setDocumentSequence(documentSequence + 1); setDocumentRequest({ path, requestId: documentSequence + 1 }); setView("docs");
  }}>{compact ? (
    <ScrollView scrollRef={compactScroll} memoryKey={pageKey(scope, "compact", view, selection?.serverId ?? "", selection?.workspaceId ?? "")}
      onLayout={event => { compactScrollState.current.height = event.nativeEvent.layout.height; }}
      onContentSizeChange={(_width, height) => { compactScrollState.current.contentHeight = height; }}
      onScroll={event => { compactScrollState.current.offset = event.nativeEvent.contentOffset.y; }}
      style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: 14, gap: 13 }}>{header}{body}</ScrollView>
  ) : (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0, padding: 18, gap: 14 }}>{header}{body}</View>
  )}</VaultDocumentLinks>;
}
import { CompactLink } from "./compact-link";
import { Breadcrumbs } from "./breadcrumbs";
