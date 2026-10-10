import { useHosts, useRpc as useInstallationRpc, type PluginHostSummary, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { getOrchestratorBindings, ORCHESTRATOR_HOST_FILE, type OrchestratorBinding } from "../shared/orchestrator";
import { AgentTree, treeSummaryLine } from "./agent-tree";
import { AppModal } from "./app-modal";
import { Attention } from "./attention";
import { Breadcrumbs } from "./breadcrumbs";
import { CompactLink } from "./compact-link";
import { formatDateTime } from "./date-time";
import { VaultDocumentLinks } from "./document-links";
import type { MissionControlCopy } from "./host-bridge";
import { changeSummary, hostReviewItems, needsYouCount, pullRequestSummary, type ReviewItem } from "./host-review-model";
import { hostReviewRequestVersion, subscribeHostReviewRequests, takeHostReviewRequest } from "./host-review-request";
import { HostRpcProvider, useMissionControlCopy } from "./host-rpc";
import { InfoTip } from "./info-tip";
import { MissionDocs } from "./mission-docs";
import { MissionReview } from "./mission-review";
import { pageKey } from "./page-memory";
import { PageScrollView, usePageState } from "./page-state";
import { useCollapsedProjects } from "./project-collapse";
import { ProjectHeader } from "./project-header";
import { projectCollapseKey, summarizeProjectAgents } from "./project-summary";
import { rosterQuery, useLiveRoster, type Agent, type Project, type Roster, type Workspace } from "./roster";
import { WorkspaceFilterBar, type WorkspaceShowFilter } from "./workspace-filter-bar";
import { filterWorkspaceEntries } from "./workspace-filters";
import { MissionTasksEditor } from "./workspace-tasks";

type Colors = PluginWorkspacePanelProps["theme"]["colors"];
type Navigation = PluginWorkspacePanelProps["navigation"];
type HostTab = "workspaces" | "attention" | "tasks" | "review" | "docs";

// Task counts live in each host's own vault, so this view offers only the filters it can answer.
const SHOW_FILTERS: readonly WorkspaceShowFilter[] = ["all", "active", "attention"];
const STATUS_LABELS = ["Ready", "In Progress", "Review", "Blocked", "Paused", "Done"];
const HOST_TABS: readonly HostTab[] = ["workspaces", "attention", "tasks", "review", "docs"];
const HOST_TAB_TITLES: Record<HostTab, string> = { workspaces: "Workspaces", attention: "Attention", tasks: "Tasks", review: "Review", docs: "Docs" };

function statusColor(status: string, colors: Colors): string {
  if (status === "running") return colors.statusSuccess;
  if (status === "failed") return colors.statusDanger;
  if (status === "attention" || status === "needs_input") return colors.statusWarning;
  return colors.foregroundMuted;
}

function timeLabel(value: string | null): string {
  return value ? formatDateTime(value) : "No activity yet";
}

function projectsOf(roster: Roster): Project[] {
  const projects = new Map(roster.projects.map(project => [project.id, project]));
  for (const workspace of roster.workspaces) if (!projects.has(workspace.projectId)) projects.set(workspace.projectId, { id: workspace.projectId, name: workspace.projectName });
  return [...projects.values()].filter(project => roster.workspaces.some(workspace => workspace.projectId === project.id));
}

function Badge({ text, colors }: { text: string; colors: Colors }) {
  return <View style={{ borderColor: colors.border, borderWidth: 1, borderRadius: 5, backgroundColor: colors.surface2, paddingHorizontal: 6, paddingVertical: 3 }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{text}</Text>
  </View>;
}

/** Branch, changes and pull request, as Paseo reads them on the workspace's host. */
function GitLine({ workspace, colors }: { workspace: Workspace; colors: Colors }) {
  const parts = [workspace.branch, changeSummary(workspace), workspace.pullRequest ? pullRequestSummary(workspace.pullRequest) : null].filter(Boolean);
  if (!parts.length) return null;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
    <Icon name="GitBranch" size={12} color={colors.foregroundMuted} />
    <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>{parts.join(" · ")}</Text>
  </View>;
}

/** Why another host's tasks, documents and Review can't be shown here, and what fixes it. */
function copyProblem(missing: "none" | "older" | "newer", hostLabel: string, online: boolean): string {
  if (!online) return `${hostLabel} isn't connected, so its Mission Control can't be reached. Connect it in Paseo.`;
  if (missing === "older") return `Mission Control on ${hostLabel} is older than this screen. Update it there (Settings → Plugins → Mission Control → Updates).`;
  if (missing === "newer") return `Mission Control on ${hostLabel} is newer than on this PC. Update Mission Control here.`;
  return `This comes from Mission Control on ${hostLabel}, which isn't installed there or is too old to answer this screen. Install or update it on ${hostLabel}.`;
}

/**
 * The Host agents tab of a workspace that orchestrates a remote host: that host's workspaces and agents,
 * read live from Paseo, and its Attention, Tasks, Review and Docs, read from its own Mission Control.
 */
export function HostAgentsPanel({ theme, host, layout, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const colors = theme.colors;
  const readBindings = useInstallationRpc(getOrchestratorBindings);
  const bindingQuery = useQuery({
    queryKey: ["mission-control", "orchestrator-binding", host.id, workspaceId],
    queryFn: () => readBindings({ workspaceIds: [workspaceId] }),
    staleTime: 30_000, retry: false,
  });
  const binding = bindingQuery.data?.bindings[workspaceId] ?? null;
  const problem = bindingQuery.data?.problems[workspaceId] ?? null;
  const remote = useHosts().find(candidate => candidate.serverId === binding?.serverId) ?? null;
  const message = (text: string, tone = colors.foregroundMuted) => <View style={{ flex: 1, padding: 18, gap: 8, backgroundColor: colors.surface0 }}>
    <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "600" }}>Host agents</Text>
    <Text style={{ color: tone, fontSize: 13 }}>{text}</Text>
  </View>;
  if (bindingQuery.isPending) return message("Reading this workspace's host…");
  if (bindingQuery.isError) return message(`This workspace's host can't be read: ${bindingQuery.error instanceof Error ? bindingQuery.error.message : String(bindingQuery.error)}`, colors.statusDanger);
  if (problem) return message(problem, colors.statusWarning);
  if (!binding) return message(`This workspace doesn't orchestrate a remote host. To link it, put a ${ORCHESTRATOR_HOST_FILE} in its folder: { "schemaVersion": 1, "label": "<host name>", "serverId": "<the host's Paseo server ID>" }.`);
  if (!remote) return message(`${binding.label} (${binding.serverId}) isn't one of this app's hosts. Add it in Paseo, then reopen this tab.`, colors.statusWarning);
  return <HostView key={binding.serverId} binding={binding} remote={remote} localServerId={host.id} workspaceId={workspaceId} theme={theme} layout={layout} navigation={navigation} />;
}

function HostView({ binding, remote, localServerId, workspaceId, theme, layout, navigation }: {
  binding: OrchestratorBinding; remote: PluginHostSummary; localServerId: string; workspaceId: string;
  theme: PluginWorkspacePanelProps["theme"]; layout: PluginWorkspacePanelProps["layout"]; navigation: Navigation;
}) {
  const colors = theme.colors;
  const compact = layout.compact;
  const serverId = binding.serverId;
  const online = remote.status === "online";
  const scope = pageKey(localServerId, "host-agents", workspaceId, serverId);
  const [view, setView] = usePageState<HostTab>(`${scope}:view`, "workspaces");
  const [search, setSearch] = usePageState(`${scope}:search`, "");
  const [show, setShow] = usePageState<WorkspaceShowFilter>(`${scope}:show`, "all");
  const [label, setLabel] = usePageState(`${scope}:label`, "all");
  const [projectIds, setProjectIds] = usePageState<string[]>(`${scope}:projects`, []);
  // The workspace the Workspaces page, Tasks and Review are showing; null lists them instead.
  const [openId, setOpenId] = usePageState<string | null>(`${scope}:workspace`, null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [docsTaskId, setDocsTaskId] = useState<string | null>(null);
  const [docsRequest, setDocsRequest] = useState<{ path: string; requestId: number } | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const collapsed = useCollapsedProjects();
  const bridge = useMissionControlCopy(serverId);
  useLiveRoster(serverId, online);
  const query = useQuery(rosterQuery(serverId, online));
  const roster = query.data;

  // A Review bubble asks for the list; take the request whether the tab was open already or just mounted.
  const requests = useSyncExternalStore(subscribeHostReviewRequests, hostReviewRequestVersion, hostReviewRequestVersion);
  useEffect(() => { if (takeHostReviewRequest(workspaceId)) setReviewOpen(true); }, [requests, workspaceId]);

  const canNavigate = online && navigation !== undefined;
  function go(action: () => void) {
    try { action(); setNavigationError(null); } catch (error) { setNavigationError(error instanceof Error ? error.message : String(error)); }
  }
  // focusHost asks newer Paseo clients to show the destination host in the sidebar; older ones ignore it.
  const openWorkspace = (id: string) => go(() => { const target = { serverId, workspaceId: id, focusHost: true }; navigation?.openWorkspace(target); });
  const openAgent = (id: string) => go(() => { const target = { serverId, agentId: id, focusHost: true }; navigation?.openAgent(target); });
  const openReview = (id: string) => { setReviewOpen(false); setOpenId(id); setView("review"); };
  const openTasks = (id: string) => { setOpenId(id); setView("tasks"); };
  const openDocs = (taskId: string | null, path: string | null = null) => {
    setDocsTaskId(taskId);
    setDocsRequest(path ? { path, requestId: Date.now() } : null);
    setView("docs");
  };

  const agents = roster?.agents ?? [];
  const review = roster ? hostReviewItems(roster.workspaces, agents) : { ready: [], changed: [] };
  const labelNames = new Map<string, string>();
  for (const name of [...STATUS_LABELS, ...(roster?.workspaces.flatMap(workspace => workspace.labels) ?? [])]) if (!labelNames.has(name.trim().toLowerCase())) labelNames.set(name.trim().toLowerCase(), name);
  const visible = filterWorkspaceEntries(roster?.workspaces ?? [], { search, projectIds, label }, workspace => {
    if (show === "attention") return agents.some(agent => agent.workspaceId === workspace.id && agent.requiresAttention);
    if (show === "active") return agents.some(agent => agent.workspaceId === workspace.id && agent.status === "running");
    return true;
  });
  const projects = roster ? projectsOf(roster) : [];
  const visibleProjects = projects.filter(project => visible.some(workspace => workspace.projectId === project.id));
  const opened = roster?.workspaces.find(workspace => workspace.id === openId) ?? null;
  const needs = needsYouCount(agents);
  const reviewLabel = review.ready.length ? `Review · ${review.ready.length} ready` : review.changed.length ? `Review · ${review.changed.length} changed` : "Review";

  const header = <View style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <Icon name="Server" size={18} color={colors.accent} />
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 20, fontWeight: "700", flexShrink: 1 }}>{binding.label} agents</Text>
      <InfoTip label="About this tab" text={`This workspace orchestrates ${binding.label}, as its ${ORCHESTRATOR_HOST_FILE} says. Workspaces and agents are read live from ${binding.label}'s Paseo. Attention, Tasks, Review and Docs come from Mission Control on ${binding.label}, so they need it installed there.`} colors={colors} />
      <View style={{ flex: 1 }} />
      <CompactLink label={reviewLabel} icon="FileDiff" colors={colors} disabled={!roster} onPress={() => setReviewOpen(true)} />
      <CompactLink label={query.isFetching ? "Refreshing…" : "Refresh"} accessibilityLabel={`Refresh ${binding.label}`} colors={colors} disabled={!online || query.isFetching} onPress={() => void query.refetch()} />
    </View>
    <Text style={{ color: online ? colors.foregroundMuted : colors.statusWarning, fontSize: 12 }}>
      {[remote.status, roster ? `${roster.workspaces.length} workspaces` : null, roster ? `${agents.length} agents` : null, needs ? `${needs} need you` : null, roster ? `updated ${formatDateTime(roster.observedAt)}` : null].filter(Boolean).join(" · ")}
    </Text>
    {!online ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{binding.label} is {remote.status}. {roster ? "Showing the last list read." : "Connect it in Paseo to load its workspaces."}</Text> : null}
    {query.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>Couldn't read {binding.label}: {query.error instanceof Error ? query.error.message : String(query.error)}</Text> : null}
    {roster?.hasMore ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{binding.label} has more workspaces or agents than this view loaded.</Text> : null}
    {navigationError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>Couldn't open it: {navigationError}</Text> : null}
    {!navigation ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Opening workspaces and agents isn't available in this client.</Text> : null}
  </View>;

  const tabs = <View style={{ flexDirection: "row", flexWrap: "wrap", gap: compact ? 10 : 16, borderBottomColor: colors.border, borderBottomWidth: 1 }}>
    {HOST_TABS.map(id => {
      const selected = view === id;
      const title = id === "attention" && needs ? `Attention (${needs})` : HOST_TAB_TITLES[id];
      return <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => setView(id)} style={{ minHeight: 40, justifyContent: "center" }}>
        <Text style={{ color: selected ? colors.accent : colors.foregroundMuted, fontWeight: selected ? "600" : "400" }}>{title}</Text>
      </Pressable>;
    })}
  </View>;

  const scroll = (key: string, children: ReactNode) => <PageScrollView memoryKey={pageKey(scope, key)} style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ gap: 12, paddingBottom: 12 }}>{children}</PageScrollView>;

  // Views from the host's own Mission Control: its vault, decisions and checkouts.
  function fromHost(render: (copy: MissionControlCopy) => ReactNode, fallback?: ReactNode) {
    if ("copy" in bridge) return <HostRpcProvider copy={bridge.copy}>
      <VaultDocumentLinks serverId={serverId} scope={`${scope}:${view}:${openId ?? ""}`} onOpen={path => openDocs(null, path)}>{render(bridge.copy)}</VaultDocumentLinks>
    </HostRpcProvider>;
    return scroll(`${view}:unavailable`, <>
      <Text style={{ color: colors.statusWarning, fontSize: 13 }}>{copyProblem(bridge.missing, binding.label, online)}</Text>
      {fallback}
    </>);
  }

  const workspacePicker = (purpose: string) => scroll(`${view}:picker`, <>
    <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>Choose a workspace for {purpose}</Text>
    {roster ? [...roster.workspaces].sort((a, b) => (Date.parse(b.activityAt ?? "") || 0) - (Date.parse(a.activityAt ?? "") || 0)).map(workspace =>
      <WorkspaceRow key={workspace.id} workspace={workspace} agents={agents} hostLabel={binding.label} colors={colors} onPress={() => setOpenId(workspace.id)} />)
      : <Text style={{ color: colors.foregroundMuted }}>Loading {binding.label}'s workspaces…</Text>}
  </>);

  const changeWorkspace = (title: string, onChange: () => void) => <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, paddingBottom: 6 }}>
    <View style={{ flex: 1, minWidth: 160, gap: 3 }}>
      <Breadcrumbs colors={colors} segments={[binding.label, opened?.projectName ?? "", opened?.name ?? ""]} />
      <Text numberOfLines={2} style={{ color: colors.foreground, fontWeight: "600", fontSize: 15 }}>{title}</Text>
    </View>
    <CompactLink label="Change workspace" colors={colors} onPress={onChange} />
  </View>;

  let body: ReactNode;
  if (view === "workspaces") body = scroll(opened ? `page:${opened.id}` : "list", opened ? <>
    <CompactLink label="← All workspaces" colors={colors} onPress={() => setOpenId(null)} />
    <View style={{ gap: 6 }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 18, fontWeight: "700" }}>{opened.name}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Breadcrumbs colors={colors} segments={[binding.label, opened.projectName, opened.name]} />
        <Text style={{ color: statusColor(opened.status, colors), fontSize: 13 }}>· {opened.status.replaceAll("_", " ")}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>· Activity: {timeLabel(opened.activityAt)}</Text>
        {opened.labels.map(name => <Badge key={name.toLowerCase()} text={name} colors={colors} />)}
      </View>
      <GitLine workspace={opened} colors={colors} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CompactLink label="Open review" icon="FileDiff" colors={colors} onPress={() => openReview(opened.id)} />
        <CompactLink label="Tasks" icon="ListTodo" colors={colors} onPress={() => openTasks(opened.id)} />
        <CompactLink label="Open workspace" colors={colors} disabled={!canNavigate} onPress={() => openWorkspace(opened.id)} />
      </View>
    </View>
    <AgentTree key={`${serverId}:${opened.id}`} serverId={serverId} localServerId={localServerId} workspaceId={opened.id} online={online} colors={colors} canNavigate={canNavigate} openAgent={openAgent}
      heading={(counts, { refresh, refreshing }) => <View style={{ gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600", flex: 1 }}>Agents ({counts.agents})</Text>
          <CompactLink label={refreshing ? "Refreshing…" : "Refresh"} accessibilityLabel="Refresh agents" colors={colors} disabled={refreshing} onPress={refresh} />
        </View>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{treeSummaryLine(counts)}</Text>
      </View>} />
  </> : <>
    <WorkspaceFilterBar colors={colors} search={search} onSearch={setSearch} show={show} onShow={setShow} showFilters={SHOW_FILTERS}
      label={label} labels={[...labelNames.values()]} onLabel={setLabel}
      projectIds={projectIds} projects={projects.length > 1 || projectIds.length ? projects : null} onProjects={setProjectIds}
      shown={visible.length} total={roster?.workspaces.length ?? 0}
      actions={visibleProjects.length ? <>
        <CompactLink label="Expand all" colors={colors} onPress={() => collapsed.setAll(visibleProjects.map(project => projectCollapseKey(serverId, project.id)), false)} />
        <CompactLink label="Collapse all" colors={colors} onPress={() => collapsed.setAll(visibleProjects.map(project => projectCollapseKey(serverId, project.id)), true)} />
      </> : null} />
    {collapsed.error ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning, fontSize: 12 }}>{collapsed.error}</Text> : null}
    {online && query.isPending ? <Text style={{ color: colors.foregroundMuted }}>Loading {binding.label}'s workspaces…</Text> : null}
    {roster && visible.length === 0 ? <Text style={{ color: colors.foregroundMuted }}>{roster.workspaces.length ? "No workspaces match these filters." : `No workspaces on ${binding.label}.`}</Text> : null}
    {visibleProjects.map(project => {
      const workspaces = visible.filter(workspace => workspace.projectId === project.id);
      const key = projectCollapseKey(serverId, project.id);
      const isCollapsed = collapsed.isCollapsed(key);
      return <View key={project.id} style={{ gap: 8, paddingBottom: isCollapsed ? 2 : 8 }}>
        <ProjectHeader name={project.name} collapsed={isCollapsed} onToggle={() => collapsed.toggle(key)} workspaceCount={workspaces.length}
          summary={summarizeProjectAgents(workspaces, agents)} tasks={null} tasksLabel="" colors={colors} />
        {isCollapsed ? null : workspaces.map(workspace => <WorkspaceRow key={workspace.id} workspace={workspace} agents={agents} hostLabel={binding.label} colors={colors} onPress={() => setOpenId(workspace.id)} />)}
      </View>;
    })}
  </>);
  else if (view === "attention") body = fromHost(() => <Attention colors={colors} compact={compact} serverId={serverId} hosts={[remote]} rosters={[{ data: roster, isError: query.isError }]} memory={pageKey(scope, "attention")} actions={{
    openAgent: (_serverId, agentId) => openAgent(agentId),
    openDocs: (_workspaceId, taskId) => openDocs(taskId),
    openReview,
  }} />, <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{needs ? `${needs} of ${binding.label}'s agents need you: use Needs attention on the Workspaces tab to find them.` : `No agent on ${binding.label} is waiting on you.`}</Text>);
  else if (view === "tasks") body = !opened ? workspacePicker("tasks") : fromHost(() => <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
    {changeWorkspace("Tasks", () => setOpenId(null))}
    <MissionTasksEditor key={`${serverId}:${opened.id}`} theme={theme} host={{ id: serverId, label: binding.label }} layout={layout} navigation={navigation}
      workspaceId={opened.id} workspaceName={opened.name} projectId={opened.projectId} projectName={opened.projectName} workspaceStatus={opened.status} embedded onOpenDocs={taskId => openDocs(taskId)} />
  </View>);
  else if (view === "review") body = !opened
    ? scroll("review:list", <ReviewSections hostLabel={binding.label} ready={review.ready} changed={review.changed} loaded={Boolean(roster)} colors={colors} canNavigate={canNavigate}
      openReview={openReview} openWorkspace={openWorkspace} openAgent={openAgent} showDetails={id => { setOpenId(id); setView("workspaces"); }} />)
    : fromHost(() => <MissionReview key={`${serverId}:${opened.id}`} serverId={serverId} localServerId={serverId} online={online} colors={colors} compact={compact}
      workspace={{ id: opened.id, name: opened.name, projectName: opened.projectName, hostLabel: binding.label }} onChangeWorkspace={() => setOpenId(null)} />,
    <View style={{ gap: 8 }}>
      <CompactLink label="← All reviews" colors={colors} onPress={() => setOpenId(null)} />
      <Text style={{ color: colors.foreground, fontWeight: "600" }}>{opened.name}</Text>
      <GitLine workspace={opened} colors={colors} />
      <CompactLink label="Open workspace" colors={colors} disabled={!canNavigate} onPress={() => openWorkspace(opened.id)} />
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Open workspace shows its changes in Paseo on {binding.label}.</Text>
    </View>);
  else body = fromHost(() => <MissionDocs key={serverId} theme={theme} host={{ id: serverId, label: binding.label }} hostLabel={binding.label} layout={layout}
    initialTaskId={docsTaskId} initialDocument={docsTaskId ? null : docsRequest} onDocumentHandled={() => setDocsRequest(null)} />);

  return <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0, padding: compact ? 12 : 18, gap: 12 }}>
    {header}
    {tabs}
    <View style={{ flex: 1, minHeight: 0 }}>{body}</View>
    <AppModal colors={colors} title={`Review on ${binding.label}`} open={reviewOpen} onOpenChange={next => { if (!next) setReviewOpen(false); }} maxWidth={760}
      icon={<Icon name="FileDiff" size={18} color={colors.foreground} />}>
      <AppModal.Content>
        <ReviewSections hostLabel={binding.label} ready={review.ready} changed={review.changed} loaded={Boolean(roster)} colors={colors} canNavigate={canNavigate}
          openReview={openReview} openWorkspace={id => { setReviewOpen(false); openWorkspace(id); }} openAgent={id => { setReviewOpen(false); openAgent(id); }}
          showDetails={id => { setReviewOpen(false); setOpenId(id); setView("workspaces"); }} />
      </AppModal.Content>
    </AppModal>
  </View>;
}

function WorkspaceRow({ workspace, agents, hostLabel, colors, onPress }: { workspace: Workspace; agents: readonly Agent[]; hostLabel: string; colors: Colors; onPress: () => void }) {
  const own = agents.filter(agent => agent.workspaceId === workspace.id);
  return <Pressable accessibilityRole="button" accessibilityLabel={`Show ${workspace.name} on ${hostLabel}`} onPress={onPress}
    style={({ pressed }) => ({ marginLeft: 12, backgroundColor: pressed ? colors.surface2 : colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 7, padding: 10, gap: 4 })}>
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 6 }}>
      <Text numberOfLines={1} style={{ color: colors.foreground, fontWeight: "600", flex: 1 }}>{workspace.name}</Text>
      <Text style={{ color: statusColor(workspace.status, colors), fontSize: 12 }}>{workspace.status.replaceAll("_", " ")}</Text>
    </View>
    {workspace.labels.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>{workspace.labels.slice(0, 4).map(name => <Badge key={name.toLowerCase()} text={name} colors={colors} />)}</View> : null}
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{own.length} {own.length === 1 ? "agent" : "agents"} · {timeLabel(workspace.activityAt)}</Text>
    <GitLine workspace={workspace} colors={colors} />
  </Pressable>;
}

type CardActions = { canNavigate: boolean; openReview: (id: string) => void; openWorkspace: (id: string) => void; openAgent: (id: string) => void; showDetails: (id: string) => void };

/** What's ready on the host: workspaces labelled Review first, then other workspaces with changes. */
function ReviewSections({ hostLabel, ready, changed, loaded, colors, ...actions }: CardActions & {
  hostLabel: string; ready: ReviewItem[]; changed: ReviewItem[]; loaded: boolean; colors: Colors;
}) {
  const section = (title: string, hint: string, items: ReviewItem[]) => <View style={{ gap: 8 }}>
    <View style={{ gap: 2 }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>{title} ({items.length})</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{hint}</Text>
    </View>
    {items.map(item => <ReviewCard key={item.workspace.id} item={item} colors={colors} {...actions} />)}
  </View>;
  if (!loaded) return <Text style={{ color: colors.foregroundMuted }}>{hostLabel}'s workspaces haven't loaded yet.</Text>;
  if (ready.length + changed.length === 0) return <Text style={{ color: colors.foregroundMuted }}>Nothing on {hostLabel} is waiting for review: no workspace is labelled Review, and none with stopped agents has changes. Open review on any workspace's page reviews it anyway.</Text>;
  return <View style={{ gap: 16 }}>
    {ready.length ? section("Ready for review", "Workspaces labelled Review.", ready) : null}
    {changed.length ? section("Other changes", "Workspaces with changes whose agents have stopped, not labelled Done or Paused.", changed) : null}
  </View>;
}

function ReviewCard({ item, colors, canNavigate, openReview, openWorkspace, openAgent, showDetails }: CardActions & { item: ReviewItem; colors: Colors }) {
  const { workspace, agents } = item;
  const latest = agents[0] ?? null;
  const agentLine = latest ? [
    `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`,
    `latest: ${latest.name} (${latest.requiresAttention ? "needs you" : latest.status})`,
    latest.summary,
  ].filter(Boolean).join(" · ") : "No open agents";
  return <View style={{ borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 12, gap: 6, backgroundColor: colors.surface0 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text numberOfLines={2} style={{ color: colors.foreground, fontWeight: "600", fontSize: 14, flex: 1 }}>{workspace.name}</Text>
      <Text style={{ color: statusColor(workspace.status, colors), fontSize: 12 }}>{workspace.status.replaceAll("_", " ")}</Text>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{workspace.projectName} · {timeLabel(workspace.activityAt)}</Text>
      {workspace.labels.map(name => <Badge key={name.toLowerCase()} text={name} colors={colors} />)}
    </View>
    <GitLine workspace={workspace} colors={colors} />
    <Text numberOfLines={3} style={{ color: colors.foregroundMuted, fontSize: 12 }}>{agentLine}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <CompactLink label="Open review" icon="FileDiff" colors={colors} onPress={() => openReview(workspace.id)} />
      <CompactLink label="Open workspace" colors={colors} disabled={!canNavigate} onPress={() => openWorkspace(workspace.id)} />
      {latest ? <CompactLink label="Open agent" colors={colors} disabled={!canNavigate} onPress={() => openAgent(latest.id)} /> : null}
      <CompactLink label="Show agents" colors={colors} onPress={() => showDetails(workspace.id)} />
    </View>
  </View>;
}
