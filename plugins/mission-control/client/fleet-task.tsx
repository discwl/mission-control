import { useHosts, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import type { FleetAgent, FleetCoordinator, FleetHost, FleetTask } from "../shared/fleet";
import { taskWorkflow, workerDepth, workflowStages } from "../shared/fleet-model";
import { HostRpcProvider, useMissionControlCopy } from "./host-rpc";
import { CompactLink } from "./compact-link";
import { DecisionCard } from "./decision-card";
import { PermissionCard } from "./permissions";
import { WaitingCardView } from "./attention-card";
import { agentKey, mayReadChat, pendingPrompts, waitingCards, type Replied } from "./attention-model";
import { rosterQuery, useLiveRoster } from "./roster";
import { TaskFlowDetail } from "./task-flow";
import { MissionReview } from "./mission-review";
import { MergeButton, MergeDialog, useMergeReady, type MergeTarget } from "./merge-action";
import { PullRequestButton, PullRequestDialog, type PullRequestTarget } from "./pull-request-action";
import { formatDateTime } from "./date-time";
import { SavedPlanView } from "./plan-approval";
import { taskDestination, taskTabKey, type TaskTab } from "./fleet-navigation";
import { usePageState } from "./page-state";
import { ReviewReadiness } from "./review-readiness";

type Colors = PluginSurfaceProps["theme"]["colors"];
type OpenAgent = (serverId: string, agentId: string) => void;
export function FleetWorkerTree({ workers, serverId, colors, openAgent }: { workers: FleetAgent[]; serverId: string; colors: Colors; openAgent: OpenAgent }) {
  return <View style={{ gap: 8 }}>
    {!workers.length ? <Text style={{ color: colors.foregroundMuted }}>No managed workers found.</Text> : null}
    {[...workers].sort((a, b) => (b.activityAt ?? "").localeCompare(a.activityAt ?? "")).map(agent => <View key={agent.id} style={{ marginLeft: workerDepth(agent, workers) * 14, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: agent.status === "running" ? colors.accent : colors.border, gap: 4 }}>
      <Text style={{ color: colors.foreground, fontWeight: "600" }}>{agent.name}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{agent.status} · {agent.labels["paseo.parent-agent-id"] ? "Native child" : "Linked worker"} · {agent.activityAt ? formatDateTime(agent.activityAt) : "No activity timestamp"}</Text>
      <CompactLink label="Open conversation" colors={colors} onPress={() => openAgent(serverId, agent.id)} />
    </View>)}
  </View>;
}

function TaskAttention({ entry, workers, host, colors, openAgent }: { entry: FleetTask; workers: FleetAgent[]; host: FleetHost; colors: Colors; openAgent: OpenAgent }) {
  const remote = useHosts().find(item => item.serverId === host.serverId);
  const online = remote?.status === "online";
  useLiveRoster(host.serverId, online);
  const query = useQuery(rosterQuery(host.serverId, online));
  const [replied, setReplied] = useState<Replied>({});
  const allowed = new Set(workers.map(agent => agent.id));
  const roster = query.data ? { ...query.data, agents: query.data.agents.filter(agent => allowed.has(agent.id)) } : undefined;
  const hosts = remote ? [remote] : [];
  const rosters = [{ data: roster }];
  const prompts = pendingPrompts(hosts, rosters);
  const waiting = waitingCards({ hosts, rosters, localServerId: host.serverId, questions: entry.questions, replied });
  const decisions = entry.decisions.filter(item => item.decision.status === "open");
  return <View style={{ gap: 12 }}>
    <Text style={{ color: colors.foregroundMuted }}>Your replies and decisions apply to this task on {remote?.label ?? host.serverId}.</Text>
    {!online || query.isError ? <Text style={{ color: colors.statusWarning }}>Current worker prompts are unavailable. Reconnect or refresh before acting.</Text> : null}
    {prompts.map(({ agent, request }) => <PermissionCard key={request.id} serverId={host.serverId} agentId={agent.id} agentName={agent.name} request={request} colors={colors} brief task={{ title: entry.task.title, place: remote?.label ?? host.serverId }} readChat={mayReadChat(agent)} openAgent={() => openAgent(host.serverId, agent.id)} />)}
    {waiting.map(card => <WaitingCardView key={card.key} card={card} colors={colors} openAgent={openAgent} onReplied={card => setReplied(current => ({ ...current, [agentKey(card.serverId, card.agentId)]: new Date().toISOString() }))} />)}
    {online ? decisions.map(decision => <DecisionCard key={decision.decision.decisionId} entry={decision} serverId={host.serverId} hostLabel={remote?.label ?? host.serverId} colors={colors} actions={{ describe: () => null, openAgent: id => openAgent(host.serverId, id), agentOf: id => roster?.agents.find(agent => agent.id === id) ?? null }} />) : null}
    {!prompts.length && !waiting.length && !decisions.length ? <Text style={{ color: colors.foregroundMuted }}>No open prompts or decisions returned for this task.</Text> : null}
    {entry.questions.some(question => question.question.status === "open" && !waiting.some(card => card.question?.question.questionId === question.question.questionId)) ? <Text style={{ color: colors.statusWarning }}>A recorded question could not be matched to a current worker. Inspect its conversation before resuming.</Text> : null}
  </View>;
}

function TaskPlan({ entry, host, colors, openAgent }: { entry: FleetTask; host: FleetHost; colors: Colors; openAgent: OpenAgent }) {
  const [selected, setSelected] = useState<string | null>(null);
  const hostLabel = useHosts().find(item => item.serverId === host.serverId)?.label ?? "Remote host";
  const describe = (workspaceId: string) => {
    const workspace = host.workspaces.find(item => item.id === workspaceId);
    return { hostLabel, projectName: workspace?.projectName ?? "Project unavailable", workspaceName: workspace?.name ?? "Workspace unavailable" };
  };
  const plans = entry.decisions.filter(item => item.decision.kind === "plan").sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt));
  const current = plans.find(item => item.decision.decisionId === selected) ?? plans.find(item => item.decision.status === "open") ?? plans[0];
  return <View style={{ gap: 14 }}>
    <Text style={{ color: colors.foregroundMuted }}>Review the intended behavior, scope and success checks before approving. Review acceptance and delivery remain separate decisions.</Text>
    {plans.length > 1 ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{plans.map(item => <CompactLink key={item.decision.decisionId} label={`${formatDateTime(item.decision.requestedAt)} · ${item.decision.status.replaceAll("_", " ")}`} colors={colors} selected={current?.decision.decisionId === item.decision.decisionId} onPress={() => setSelected(item.decision.decisionId)} />)}</View> : null}
    {current?.decision.resume && current.decision.resume.phase !== "sent" ? <View style={{ gap: 6 }}><Text style={{ color: colors.statusWarning }}>Decision saved; delivery to the worker is {current.decision.resume.phase === "sending" ? "unconfirmed" : "pending"}. {current.decision.resume.error || "Inspect the decision in Attention before resuming work."}</Text>{current.decision.agentId ? <CompactLink label="Inspect worker conversation" colors={colors} onPress={() => openAgent(host.serverId, current.decision.agentId!)} /> : null}</View> : null}
    {current ? current.decision.status === "open" ? <DecisionCard key={current.decision.decisionId} entry={current} serverId={host.serverId} hostLabel={hostLabel} colors={colors} actions={{ describe, openAgent: id => openAgent(host.serverId, id) }} /> : <SavedPlanView key={current.decision.decisionId} entry={current} serverId={host.serverId} colors={colors} /> : <Text style={{ color: colors.foregroundMuted }}>No plan decision has been recorded for this task. Its working documents are available under Evidence.</Text>}
  </View>;
}

function TaskDelivery({ entry, serverId, colors }: { entry: FleetTask; serverId: string; colors: Colors }) {
  const ready = useMergeReady(serverId, true);
  const [merge, setMerge] = useState<MergeTarget | null>(null);
  const [pr, setPr] = useState<PullRequestTarget | null>(null);
  const task = ready.data?.tasks.find(task => task.taskId === entry.task.taskId);
  return <View style={{ gap: 12 }}>
    <Text style={{ color: colors.foreground }}>Accepting a review does not publish it. Inspect the exact delivery below, then approve that action separately.</Text>
    {ready.isPending ? <Text style={{ color: colors.foregroundMuted }}>Checking delivery readiness…</Text> : null}
    {ready.isError ? <Text style={{ color: colors.statusWarning }}>{String(ready.error)}</Text> : null}
    {ready.data?.warning ? <Text style={{ color: colors.statusWarning }}>{ready.data.warning}</Text> : null}
    {task ? task.delivery === "pull-request" ? <PullRequestButton serverId={serverId} taskId={task.taskId} taskTitle={task.title} online colors={colors} onOpen={setPr} /> : <MergeButton serverId={serverId} taskId={task.taskId} taskTitle={task.title} online colors={colors} onOpen={setMerge} /> : <Text style={{ color: colors.foregroundMuted }}>{entry.task.pullRequest ? `PR recorded: ${entry.task.pullRequest.url}` : "This task is not currently eligible for delivery. Inspect its review and revision evidence."}</Text>}
    <MergeDialog serverId={serverId} online colors={colors} target={merge} onClose={() => setMerge(null)} />
    <PullRequestDialog serverId={serverId} online colors={colors} target={pr} onClose={() => setPr(null)} />
  </View>;
}

export function FleetTaskDetail({ entry, coordinator, host, workers, localServerId, colors, compact, reviewHeight, openAgent, close, navigation }: { entry: FleetTask; coordinator: FleetCoordinator; host: FleetHost; workers: FleetAgent[]; localServerId: string; colors: Colors; compact: boolean; reviewHeight: number; openAgent: OpenAgent; close(): void; navigation?: PluginSurfaceProps["navigation"] }) {
  const [tab, setTab] = usePageState<TaskTab>(taskTabKey(host.serverId, coordinator.agentId, entry.task.taskId), () => taskDestination(entry, workers).tab);
  const [evidenceDocument, setEvidenceDocument] = useState<string | undefined>(undefined);
  const focusedReview = tab === "Review" || tab === "Plan";
  const openPlans = entry.decisions.filter(item => item.decision.kind === "plan" && item.decision.status === "open").length;
  const openRequests = entry.decisions.filter(item => item.decision.status === "open").length + entry.questions.filter(item => item.question.status === "open").length + workers.reduce((sum, worker) => sum + worker.pendingPermissions, 0);
  const bridge = useMissionControlCopy(host.serverId);
  const online = useHosts().some(item => item.serverId === host.serverId && item.status === "online");
  const cache = useQueryClient();
  const workflow = taskWorkflow(entry, workers);
  const workspaceId = entry.run?.workspaceId || entry.task.worktree?.workspaceId || entry.task.assignments.find(item => item.serverId === host.serverId)?.workspaceId;
  const workspace = host.workspaces.find(item => item.id === workspaceId);
  const binding = { serverId: host.serverId, workspaceId: workspaceId ?? "", taskId: entry.task.taskId };
  const content = <View style={{ gap: focusedReview ? 10 : 16 }}>
    <CompactLink label="Back to fleet" colors={colors} onPress={close} />
    <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: focusedReview ? 20 : 24, fontWeight: "700" }}>{entry.task.title}</Text>
    <Text style={{ color: colors.foregroundMuted }}>{coordinator.hostLabel} · {coordinator.name}{focusedReview ? "" : ` · ${workspace?.name ?? "Workspace unavailable"}`}</Text>
    {focusedReview ? <Text style={{ color: workflow.actor === "you" ? colors.statusWarning : colors.foregroundMuted, fontSize: 12 }}>{workflow.stage} · {workflow.next}</Text> : <>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{workflowStages.map(stage => <View key={stage} style={{ padding: 7, borderRadius: 5, borderWidth: 1, borderColor: workflow.stage === stage ? colors.accent : colors.border }}><Text style={{ color: workflow.stage === stage ? colors.accent : colors.foregroundMuted, fontSize: 11 }}>{stage}</Text></View>)}</View>
    <View style={{ padding: 14, gap: 6, borderLeftWidth: 3, borderLeftColor: workflow.actor === "you" ? colors.statusWarning : colors.accent, backgroundColor: colors.surface1 }}>
      <Text style={{ color: colors.foreground, fontWeight: "600" }}>{workflow.stage} · {workflow.actor === "you" ? "Needs you" : workflow.actor === "agent" ? "Agent's next step" : workflow.actor === "done" ? "Recorded as delivered" : "Blocked"}</Text>
      <Text selectable style={{ color: colors.foreground }}>{workflow.next}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Recorded evidence: {workflow.evidence}</Text>
    </View>
    </>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{(["Overview", "Plan", "Needs you", "Review", "Evidence", "Delivery"] as const).map(name => <CompactLink key={name} label={name === "Plan" && openPlans ? `Plan · ${openPlans} waiting` : name === "Needs you" && openRequests ? `Needs you · ${openRequests}` : name} selected={tab === name} colors={colors} onPress={() => setTab(name)} />)}<CompactLink label="Refresh" colors={colors} onPress={() => void cache.invalidateQueries({ queryKey: ["mission-control"] })} /></View>
    {tab === "Overview" ? <View style={{ gap: 16 }}>
      <Text style={{ color: colors.foreground, fontWeight: "600" }}>Acceptance criteria</Text>
      <Text selectable style={{ color: colors.foregroundMuted }}>{Array.isArray(entry.task.acceptanceCriteria) ? entry.task.acceptanceCriteria.join("\n") : entry.task.acceptanceCriteria || "No acceptance criteria recorded."}</Text>
      <CompactLink label="Open coordinator" colors={colors} onPress={() => openAgent(localServerId, coordinator.agentId)} />
      <Text style={{ color: colors.foreground, fontWeight: "600" }}>Managed workers</Text>
      <FleetWorkerTree workers={workers} serverId={host.serverId} colors={colors} openAgent={openAgent} />
    </View> : null}
    {tab !== "Overview" && (!online || !("copy" in bridge)) ? <Text style={{ color: colors.statusWarning }}>Connect {coordinator.hostLabel} and load its Mission Control plugin to use this task's actions.</Text> : null}
    {online && "copy" in bridge ? <HostRpcProvider copy={bridge.copy}>
      {tab === "Plan" ? <TaskPlan entry={entry} host={host} colors={colors} openAgent={openAgent} /> : null}
      {tab === "Needs you" ? <TaskAttention entry={entry} workers={workers} host={host} colors={colors} openAgent={openAgent} /> : null}
      {tab === "Review" ? workspace ? <View style={{ gap: 8, height: reviewHeight }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Changes belong to this workspace. Other agents using the same checkout may have contributed.</Text>
        <MissionReview sessionId={`fleet:${coordinator.agentId}:${entry.task.taskId}`} serverId={host.serverId} localServerId={host.serverId} online colors={colors} compact={compact} openWorkspace={navigation ? () => navigation.openWorkspace({ serverId: host.serverId, workspaceId: workspace.id }) : undefined} readiness={(snapshot, stale) => <ReviewReadiness entry={entry} serverId={host.serverId} workspaceId={workspace.id} online={online} snapshot={snapshot} stale={stale} complete={host.complete} colors={colors} onEvidence={document => { setEvidenceDocument(document); setTab("Evidence"); }} onDecision={() => setTab("Needs you")} />} workspace={{ ...workspace, hostLabel: coordinator.hostLabel }} onChangeWorkspace={() => setTab("Overview")} />
      </View> : <Text style={{ color: colors.statusWarning }}>The task's workspace is unavailable.</Text> : null}
      {tab === "Evidence" && workspaceId ? <View style={{ gap: 10 }}><CompactLink label="Back to review" colors={colors} onPress={() => setTab("Review")} /><TaskFlowDetail key={evidenceDocument ?? "activity"} initialDocument={evidenceDocument} task={entry.task} binding={binding} online colors={colors} hostLabel={coordinator.hostLabel} openAgent={id => openAgent(host.serverId, id)} /></View> : null}
      {tab === "Delivery" ? <TaskDelivery entry={entry} serverId={host.serverId} colors={colors} /> : null}
    </HostRpcProvider> : null}
  </View>;
  return content;
}
