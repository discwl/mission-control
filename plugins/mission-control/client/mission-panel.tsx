import { getPaseoClient, useHosts, useRpc, useSettings, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { CompactLink } from "./compact-link";
import { CopyTaskId } from "./copy-task-id";
import { Breadcrumbs } from "./breadcrumbs";
import { ProjectGit } from "./project-git";
import { TaskFlowSummary, TaskFlowDetail } from "./task-flow";
import { AppModal as Modal } from "./app-modal";
import { missionPreferences } from "../shared/preferences";
import { missionSections, missionSectionLabels, moveMissionSection, normalizeMissionSections, type MissionSection } from "../shared/mission-sections";
import { ScrollView, Text, View } from "react-native";
import { getMissionSummary } from "../shared/mission";
import { getReviewCounts } from "../shared/review";
import { listTaskRuns, type RunRecord } from "../shared/runs";
import { listTasks, type TaskRecord } from "../shared/tasks";
import { formatDateTime } from "./date-time";
import { DecisionCard } from "./decision-card";
import { useWaiting, WaitingCardView } from "./attention-card";
import { agentKey, waitingCards, type Replied } from "./attention-model";
import { useDecisions } from "./needs-you";
import { PermissionCard, type PermissionRequest } from "./permissions";
import { pluginClient } from "./plugin-client";
import { useReviewComments } from "./review-comments";
import { reviewPanelId } from "./panel-ids";
import { agentsForTask, useRoster } from "./roster";
import { parentAgentIdOf } from "../shared/subagents";
import { agentsPanelId } from "../shared/agents-panel";
import { AgentTree, treeSummaryLine } from "./agent-tree";
import { SubagentsRow, useHelpers, useTaskTitles } from "./subagents";

type Colors = PluginWorkspacePanelProps["theme"]["colors"];
type PanelAgent = { id: string; name: string; provider: string; status: string; role: string | null; parentAgentId: string | null; permissions: PermissionRequest[]; updatedAt: string };

const steps: [string, string[]][] = [["Plan", ["intake", "plan"]], ["Build", ["execute", "fix"]], ["Validate", ["validate"]], ["Review", ["review"]], ["Handoff", ["delivery", "handoff"]]];

function Section({ title, count, colors, children }: { title: string; count?: number; colors: Colors; children: ReactNode }) {
  return <View style={{ gap: 8, padding: 10, borderWidth: 1, borderColor: title === "Needs you" && count ? colors.statusWarning : colors.border, borderRadius: 8, backgroundColor: colors.surface1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 13, fontWeight: "700", flexGrow: 1 }}>{title}</Text>
      {count !== undefined ? <Text accessibilityLabel={`${count} ${title.toLowerCase()}`} style={{ color: title === "Needs you" && count ? colors.statusWarning : colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{count}</Text> : null}
    </View>
    {children}
  </View>;
}

function Stepper({ run, colors }: { run: RunRecord; colors: Colors }) {
  const current = steps.findIndex(([, stages]) => stages.includes(run.stage));
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
    {steps.map(([label], index) => {
      const active = index === current;
      return <View key={label} style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: active ? colors.accent : colors.border, backgroundColor: active ? colors.surface2 : "transparent" }}>
        <Text style={{ color: active ? colors.accent : index < current ? colors.statusSuccess : colors.foregroundMuted, fontSize: 11, fontWeight: active ? "700" : "400" }}>{index < current ? "✓ " : ""}{label}</Text>
      </View>;
    })}
  </View>;
}

/** Mission tab for Paseo's right-hand panel: what needs you, task progress, review and agents for one workspace. */
export function MissionPanel({ theme, host, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const colors = theme.colors;
  const serverId = host.id;
  const settings = useSettings(missionPreferences);
  const [customizing, setCustomizing] = useState(false);
  const [pendingOrder, setPendingOrder] = useState<MissionSection[] | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const writingOrder = useRef(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const sectionOrder = normalizeMissionSections(pendingOrder ?? (settings.status === "ready" ? settings.values.missionSectionOrder : []));
  const canReorder = settings.status === "ready" && !settings.saving && pendingOrder === null;
  async function saveSectionOrder(next: MissionSection[]) {
    if (settings.status !== "ready" || settings.saving || writingOrder.current) return;
    writingOrder.current = true;
    setPendingOrder(next);
    setOrderError(null);
    try {
      const saved = await settings.save({ ...settings.values, missionSectionOrder: next }, settings.revision);
      if (!saved) setOrderError("Section order was not saved. Reload the layout and try again.");
    } catch (error) { setOrderError(error instanceof Error ? error.message : String(error)); }
    finally { writingOrder.current = false; setPendingOrder(null); }
  }
  const online = useHosts().some(candidate => candidate.serverId === serverId && candidate.status === "online");
  const readSummary = useRpc(getMissionSummary);
  const readTasks = useRpc(listTasks);
  const readRuns = useRpc(listTaskRuns);
  const readCounts = useRpc(getReviewCounts);
  const workspace = useQuery({
    queryKey: ["mission-control", "workspace", serverId, workspaceId],
    queryFn: () => getPaseoClient(serverId).workspaces.ref(workspaceId).refresh(),
    enabled: online, staleTime: 30_000,
  });
  const agentsQuery = useQuery({
    queryKey: ["mission-control", "mission-agents", serverId, workspaceId],
    queryFn: async (): Promise<PanelAgent[]> => {
      const { entries } = await getPaseoClient(serverId).agents.list({ page: { limit: 200 } });
      return entries.map(entry => entry.agent)
        .filter(agent => agent.workspaceId === workspaceId && !agent.archivedAt && agent.status !== "closed")
        .map(agent => ({ id: agent.id, name: agent.title || `${agent.provider} agent`, provider: agent.provider, status: agent.status, role: agent.labels["mission-control.role"] || null, parentAgentId: parentAgentIdOf(agent), permissions: agent.pendingPermissions ?? [], updatedAt: agent.updatedAt }))
        .sort((a, b) => b.permissions.length - a.permissions.length || b.updatedAt.localeCompare(a.updatedAt));
    },
    enabled: online, refetchInterval: online ? 5_000 : false, retry: false,
  });
  // Tasks, decisions and review data live in this installation's vault, so they need this host.
  const summary = useQuery({ queryKey: ["mission-control", "mission-summary", serverId, workspaceId], queryFn: () => readSummary({ workspaceIds: [workspaceId] }), enabled: online, refetchInterval: online ? 15_000 : false, retry: false });
  const local = summary.data?.serverId === serverId;
  const decisions = useDecisions(serverId, online && local);
  const waiting = useWaiting(serverId, online && local);
  const [replied, setReplied] = useState<Replied>({});
  const tasks = useQuery({ queryKey: ["mission-control", "tasks", serverId, workspaceId], queryFn: () => readTasks({ serverId, workspaceId }), enabled: online && local, refetchInterval: online ? 15_000 : false, retry: false });
  const selectedTask = tasks.data?.tasks.find(task => task.taskId === selectedTaskId);
  const active = (tasks.data?.tasks ?? []).filter(task => task.status !== "delivered" && task.status !== "closed");
  const runs = useQueries({
    queries: active.map(task => ({
      queryKey: ["mission-control", "runs", serverId, workspaceId, task.taskId],
      queryFn: () => readRuns({ serverId, workspaceId, taskId: task.taskId }),
      enabled: online && local, refetchInterval: online ? 15_000 : false, retry: false,
    })),
  });
  const counts = useQuery({ queryKey: ["mission-control", "review-counts", workspaceId], queryFn: () => readCounts({ workspaceIds: [workspaceId] }), enabled: online && local, refetchInterval: online ? 20_000 : false, retry: false });
  const comments = useReviewComments(serverId, workspaceId, online && local).comments;

  const agents = agentsQuery.data ?? [];
  // The host's roster names parents outside this workspace and finds each task's agents; helpers need this host's server.
  const roster = useRoster(serverId, online);
  const localServerId = local ? serverId : "";
  const taskAgents = (taskId: string) => agentsForTask(roster.data?.agents ?? [], taskId);
  const taskTitles = useTaskTitles(localServerId, localServerId);
  const helpers = useHelpers(serverId, localServerId, active.flatMap(task => taskAgents(task.taskId)), online);
  const agentName = (id: string | null) => agents.find(agent => agent.id === id)?.name ?? "an agent";
  const openDecisions = online && local ? (decisions.data?.open ?? []).filter(entry => entry.decision.serverId === serverId && entry.decision.workspaceId === workspaceId) : [];
  const permissions = online ? agents.flatMap(agent => agent.permissions.map(request => ({ agent, request }))) : [];
  const waitingHere = waitingCards({
    hosts: [{ serverId, label: host.label, status: online ? "online" : "offline" }], rosters: [roster], localServerId: serverId,
    questions: local ? waiting.data?.questions : [], taskTitles: local ? waiting.data?.taskTitles : undefined, replied,
  }).filter(card => card.agent?.workspaceId === workspaceId);
  const needsCount = permissions.length + openDecisions.length + waitingHere.length;
  const needsError = agentsQuery.isError || roster.isError || summary.isError || (local && (decisions.isError || waiting.isError));
  const needsLoaded = online && !needsError && agentsQuery.isSuccess && roster.isSuccess && summary.isSuccess && (!local || (decisions.isSuccess && waiting.isSuccess));
  const review = counts.data?.counts[workspaceId];
  const unsent = comments.filter(comment => comment.status === "open" && !comment.delivery).length;
  const sent = comments.filter(comment => comment.status === "sent").length;
  // focusHost asks Paseo to switch its sidebar to this host; releases that don't support it ignore it.
  const openAgent = (agentId: string) => { try { const target = { serverId, agentId, focusHost: true }; navigation?.openAgent(target); } catch { /* The chat stays where it is. */ } };
  const client = pluginClient();
  const link = (label: string, onPress: () => void) => <CompactLink key={label} label={label} onPress={onPress} colors={colors} icon={label === "Mission Control" ? "ArrowUpRight" : undefined} />;
  const muted = (text: string) => <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{text}</Text>;

  function taskCard(task: TaskRecord, run: RunRecord | undefined) {
    const waiting = openDecisions.some(entry => entry.decision.taskId === task.taskId);
    return <View key={task.taskId} style={{ borderColor: run?.outcome === "in_progress" ? colors.accent : colors.border, borderWidth: 1, borderRadius: 8, padding: 10, gap: 6, backgroundColor: colors.surface0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: colors.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600", flex: 1 }}>{task.title}</Text>
        <CopyTaskId taskId={task.taskId} colors={colors} />
      </View>
      <TaskFlowSummary task={task} run={run} colors={colors} loading={online && runs[active.findIndex(candidate => candidate.taskId === task.taskId)]?.isPending} error={!online ? "Host is offline; current run cannot be refreshed." : runs[active.findIndex(candidate => candidate.taskId === task.taskId)]?.isError ? "Could not read the current run." : undefined} liveCount={online ? taskAgents(task.taskId).filter(agent => agent.status === "running").length : 0} />
      {waiting ? muted("Waiting for your decision") : null}
      <CompactLink label="Task details" icon="ClipboardList" colors={colors} onPress={() => setSelectedTaskId(task.taskId)} />
      {run ? <>
        {run.agentId ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 12, flex: 1 }}>{agentName(run.agentId)}</Text>
          {navigation ? link(`Open run agent: ${agentName(run.agentId)}`, () => openAgent(run.agentId!)) : null}
        </View> : null}
      </> : null}
      {roster.data ? <SubagentsRow serverId={serverId} parents={taskAgents(task.taskId)} agents={roster.data.agents} helpers={helpers} taskTitles={taskTitles} colors={colors} canNavigate={Boolean(navigation)} openAgent={openAgent} /> : null}
    </View>;
  }

  const remoteData = summary.isSuccess && !local;
  const sections: Record<MissionSection, ReactNode> = {
    "needs-you": <Section title="Needs you" count={needsLoaded || needsCount ? needsCount : undefined} colors={colors}>
      {permissions.map(({ agent, request }) => <PermissionCard key={request.id} serverId={serverId} agentId={agent.id} agentName={agent.name} request={request} colors={colors} compact />)}
      {openDecisions.map(entry => <DecisionCard key={`${entry.decision.decisionId}:${entry.revision}`} entry={entry} serverId={serverId} hostLabel={host.label} colors={colors}
        actions={{ describe: () => null, openAgent }} />)}
      {waitingHere.map(card => <WaitingCardView key={`${serverId}:${card.key}`} card={card} colors={colors} openAgent={(_serverId, agentId) => openAgent(agentId)}
        onReplied={answered => setReplied(current => ({ ...current, [agentKey(answered.serverId, answered.agentId)]: new Date().toISOString() }))} />)}
      {needsLoaded && !needsCount ? muted("Nothing needs you right now.") : null}
      {online && !needsLoaded && !needsError ? muted("Checking what needs you…") : null}
      {needsError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>Some Needs you requests could not be loaded. Refresh to try again.</Text> : null}
      {agentsQuery.isError ? <Text style={{ color: colors.statusDanger, fontSize: 12 }}>Agents unavailable: {agentsQuery.error instanceof Error ? agentsQuery.error.message : String(agentsQuery.error)}</Text> : null}
    </Section>,
    tasks: remoteData ? null : <Section title="Tasks" count={active.length} colors={colors}>
        {tasks.isPending && online ? muted("Loading tasks…") : null}
        {tasks.isSuccess && !active.length ? muted("No active tasks in this workspace.") : null}
        {active.map((task, index) => taskCard(task, runs[index]?.data?.runs[0]))}
        {workspace.data?.projectId ? <ProjectGit projectId={workspace.data.projectId} projectName={workspace.data.projectCustomName || workspace.data.projectDisplayName || "Project"} local={local && online} colors={colors} /> : null}
      </Section>,
    review: remoteData ? null : <Section title="Review" colors={colors}>
        {review === null ? muted("Not a Git workspace, or its changes could not be read.") : null}
        {review ? <Text style={{ color: colors.foreground, fontSize: 13 }}>{review.files === 0 ? "No changes to review." : review.toReview ? `${review.toReview} of ${review.files} files to review` : `All ${review.files} files reviewed`}</Text> : null}
        {unsent || sent ? <Text style={{ color: unsent ? colors.accent : colors.foregroundMuted, fontSize: 12 }}>💬 {unsent} not sent · {sent} sent, waiting to be resolved</Text> : null}
        {client ? link("Open Review →", () => client.openPanel(reviewPanelId, { workspaceId, location: "explorer" })) : null}
      </Section>,
    agents: <AgentTree serverId={serverId} localServerId={localServerId} workspaceId={workspaceId} online={online} colors={colors} brief
      canNavigate={Boolean(navigation) && online} openAgent={openAgent}
      heading={(counts, { refresh, refreshing, renameAll }) => <View style={{ gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
          <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 14, fontWeight: "700", flex: 1 }}>Agents ({counts.agents})</Text>
          {renameAll}
          <CompactLink label={refreshing ? "Refreshing…" : "Refresh"} colors={colors} disabled={refreshing || !online} onPress={refresh} />
          {client ? link("Open Agents →", () => client.openPanel(agentsPanelId, { workspaceId, location: "explorer" })) : null}
        </View>
        {muted(treeSummaryLine(counts))}
      </View>} />,
  };
  const layoutError = orderError ?? settings.saveError ?? (settings.status === "error" || settings.status === "invalid" ? settings.error : null);
  return <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: 12, gap: 16 }}>
    <View style={{ gap: 6 }}>
      <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "700" }}>Mission</Text>
      <Breadcrumbs colors={colors} segments={[host.label, workspace.data?.projectCustomName || workspace.data?.projectDisplayName || "…", workspace.data?.title || workspace.data?.name || "…"]} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {client ? link("Mission Control", () => client.openSurface("mission-control")) : null}
        <CompactLink label="Customize sections" iconOnly accessibilityLabel="Customize sections" expanded={customizing} onPress={() => setCustomizing(!customizing)} colors={colors} icon="Settings2" />
      </View>
    </View>
    {customizing ? <View style={{ borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 10, gap: 8 }}>
      {muted("Move sections up or down. This order is saved for this Mission Control installation.")}
      {sectionOrder.map((section, index) => <View key={section} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        <Text style={{ color: colors.foreground, fontSize: 12, flexGrow: 1 }}>{missionSectionLabels[section]}</Text>
        <CompactLink label="Up" icon="ArrowUp" accessibilityLabel={`Move ${missionSectionLabels[section]} up`} disabled={!canReorder || index === 0} colors={colors} onPress={() => void saveSectionOrder(moveMissionSection(sectionOrder, section, -1))} />
        <CompactLink label="Down" icon="ArrowDown" accessibilityLabel={`Move ${missionSectionLabels[section]} down`} disabled={!canReorder || index === sectionOrder.length - 1} colors={colors} onPress={() => void saveSectionOrder(moveMissionSection(sectionOrder, section, 1))} />
      </View>)}
      <CompactLink label="Reset order" icon="RotateCcw" colors={colors} disabled={!canReorder} onPress={() => void saveSectionOrder([...missionSections])} />
      {settings.status === "loading" ? muted("Loading section order…") : null}
      {settings.saving || pendingOrder ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 11 }}>Saving order…</Text> : null}
    </View> : null}
    {layoutError ? <View style={{ gap: 6 }}>
      <Text accessibilityRole="alert" style={{ color: colors.statusWarning, fontSize: 12 }}>Section order unavailable: {String(layoutError)}</Text>
      <CompactLink label="Reload layout" colors={colors} onPress={() => { setOrderError(null); void settings.reload(); }} />
    </View> : null}
    {!online ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>This host is offline.</Text> : null}
    {remoteData ? muted("Tasks, decisions and review data are available on the host where Mission Control is installed.") : null}
    {sectionOrder.map(section => sections[section] ? <View key={section}>{sections[section]}</View> : null)}
    <Modal colors={colors} icon={selectedTask ? <CopyTaskId key={selectedTask.taskId} taskId={selectedTask.taskId} colors={colors} /> : undefined} title={selectedTask?.title ?? "Task details"} open={Boolean(selectedTask)} onOpenChange={open => { if (!open) setSelectedTaskId(null); }}>
      <Modal.Content>{selectedTask ? <TaskFlowDetail key={selectedTask.taskId} task={selectedTask} binding={{ serverId, workspaceId, taskId: selectedTask.taskId }} online={online && local} colors={colors} hostLabel={host.label} openAgent={openAgent} /> : null}</Modal.Content>
    </Modal>
  </ScrollView>;
}
