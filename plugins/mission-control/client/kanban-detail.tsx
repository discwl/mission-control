import { useHosts, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { FleetSnapshot } from "../shared/fleet";
import { decisionReceipt } from "../shared/decision-receipt";
import { CompactLink } from "./compact-link";
import { HostRpcProvider, useMissionControlCopy } from "./host-rpc";
import { FleetWorkerTree, TaskAttention, TaskDelivery, TaskPlan } from "./fleet-task";
import { MissionReview } from "./mission-review";
import { ReviewReport } from "./review-report";
import { ReviewReadiness } from "./review-readiness";
import { TaskFlowDetail } from "./task-flow";
import { v2Workspace } from "./mission-control-v2-model";
import { kanbanCanAct, kanbanGuidance, kanbanHasRequest, type KanbanTab, type KanbanTask } from "./kanban-model";

type Colors = PluginSurfaceProps["theme"]["colors"];
const tabs: KanbanTab[] = ["Next step", "Plan", "Code review", "Decision", "Evidence", "Workers", "Receipt", "Delivery"];
const guidance: Record<KanbanTab, { title: string; steps: string[] }> = {
  "Next step": { title: "What to do now", steps: [] },
  Plan: { title: "Is this the change you want?", steps: ["Read the intended behavior and acceptance criteria.", "Check scope, exclusions, risks and how success will be tested.", "Approve only the saved plan you understand, or request specific changes below."] },
  "Code review": { title: "Does the result match the approved plan?", steps: ["Start with the change summary and unresolved findings.", "Inspect the changed files and validation evidence for this exact revision.", "Use Your decision beside the report to accept reviewed code or request fixes. Acceptance does not publish it."] },
  Decision: { title: "Make the next decision", steps: ["Plan approval permits the described implementation. Code acceptance confirms the reviewed result.", "Read the request and evidence before choosing. Stale or missing evidence must be refreshed.", "After saving, check the receipt. Worker delivery and actual progress are separate."] },
  Evidence: { title: "Read the saved evidence", steps: ["Compare the plan, validation results, review findings and handoff with the task.", "A saved document is evidence of what was recorded, not a live check of the workspace."] },
  Workers: { title: "Who is working on this task?", steps: ["Workers are linked by task identity. Agents sharing a workspace are not automatically part of this task.", "Open the worker conversation for missing context, errors or progress that has not been recorded."] },
  Receipt: { title: "What happened after your decision?", steps: ["This uses the same saved-decision receipt as Telegram.", "Sent to worker confirms delivery, not completion. A newer request needs its own decision."] },
  Delivery: { title: "Approve delivery separately", steps: ["Inspect the exact PR or delivery operation and destination.", "Code acceptance alone does not authorize publishing, merging or external updates."] },
};

export function KanbanDetail({ item, snapshot, colors, compact, height, navigation, close, refresh }: {
  item: KanbanTask; snapshot: FleetSnapshot; colors: Colors; compact: boolean; height: number;
  navigation: PluginSurfaceProps["navigation"]; close(): void; refresh(): void;
}) {
  const row = item.row;
  const [tab, setTab] = useState<KanbanTab>(item.lane === "plan" ? "Plan" : item.lane === "review" ? "Code review" : "Next step");
  const [criteria, setCriteria] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [allTabs, setAllTabs] = useState(false);
  const [document, setDocument] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const bridge = useMissionControlCopy(row.serverId);
  const online = useHosts().some(host => host.serverId === row.serverId && host.status === "online");
  const available = kanbanCanAct(row, online) && "copy" in bridge;
  const workspaceId = v2Workspace(row);
  const workspace = row.host.workspaces.find(workspace => workspace.id === workspaceId);
  const openAgent = (serverId: string, agentId: string) => {
    try { if (!navigation) throw new Error("Conversation navigation is unavailable."); navigation.openAgent({ serverId, agentId }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const evidence = (name?: string) => { setDocument(name); setTab("Evidence"); };
  const resolved = [...row.entry.decisions].filter(entry => entry.decision.status !== "open")
    .sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt))[0];
  const receipt = resolved ? decisionReceipt(resolved, row.hostLabel, row.entry.decisions) : null;
  const next = kanbanGuidance(item);
  const hasRequest = kanbanHasRequest(row);
  const activeWorkers = row.workers.filter(worker => !worker.archivedAt);
  const singleWorker = activeWorkers.length === 1 ? activeWorkers[0] : null;
  const singleCoordinator = !activeWorkers.length && row.coordinators.length === 1 ? row.coordinators[0] : null;
  const findOwnerInWorkspace = !activeWorkers.length && !row.coordinators.length && !!workspaceId && !!navigation;
  const conversationLabel = singleWorker ? "Open worker conversation" : singleCoordinator ? "Open coordinator conversation" : findOwnerInWorkspace ? "Find owner in workspace" : activeWorkers.length || row.coordinators.length ? "Choose a conversation" : "Find task owner";
  const conversation = () => {
    if (singleWorker) openAgent(row.serverId, singleWorker.id);
    else if (singleCoordinator) openAgent(snapshot.serverId, singleCoordinator.agentId);
    else if (findOwnerInWorkspace && workspaceId && navigation) {
      try { navigation.openWorkspace({ serverId: row.serverId, workspaceId }); } catch (cause) { setError(String(cause)); }
    } else setTab("Workers");
  };
  const visibleTabs = tabs.filter(name => (name !== "Decision" || (hasRequest && !row.staleReview))
    && (allTabs || ["Next step", "Workers", "Evidence", tab, next.tab, ...(hasRequest ? ["Decision"] : []), ...(receipt ? ["Receipt"] : [])].includes(name)));
  const guide = tab === "Next step" ? next : tab === "Plan" && item.lane !== "plan"
    ? { title: "Read the saved plan and planning history", steps: ["Only an open plan request can be approved. If the current plan is missing or unclear, ask the owner for a readable version and a new request."] }
    : tab === "Decision" && item.tab === "Decision" ? next
    : tab === "Decision" && !hasRequest ? { title: "No decision is waiting", steps: ["Return to Next step for the current blocker or progress. Open the linked conversation if a new request is needed."] }
    : guidance[tab];
  return <View style={{ flex: 1, minHeight: 0 }}>
    <View style={{ padding: compact ? 12 : 20, gap: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <CompactLink label="Back to Kanban" icon="ArrowLeft" colors={colors} onPress={close} />
        <Text style={{ color: colors.foregroundMuted }}>{row.hostLabel} · {row.entry.task.ticket?.key ?? row.entry.task.projectId}</Text>
        <CompactLink label="Refresh task" colors={colors} onPress={refresh} />
      </View>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: compact ? 19 : 23, lineHeight: compact ? 26 : 31, fontWeight: "600" }}>{row.entry.task.title}</Text>
      <Text style={{ color: item.needsYou || row.state === "Unconfirmed" ? colors.statusWarning : colors.foregroundMuted }}>{item.label}</Text>
      {tab !== "Next step" ? <View style={{ gap: 8 }}>
        <Text style={{ color: colors.foreground, lineHeight: 22 }}>Next: {next.title}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {tab !== next.tab && next.tab !== "Workers" ? <CompactLink label={next.action} selected colors={colors} onPress={() => setTab(next.tab)} /> : null}
          <CompactLink label={conversationLabel} icon="MessageSquare" colors={colors} onPress={conversation} />
        </View>
      </View> : null}
      <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8 }} showsHorizontalScrollIndicator={false}>
        {visibleTabs.map(name => <CompactLink key={name} label={name} selected={tab === name} colors={colors} onPress={() => setTab(name)} />)}
        <CompactLink label={allTabs ? "Fewer sections" : "All sections"} colors={colors} expanded={allTabs} onPress={() => setAllTabs(!allTabs)} />
      </ScrollView>
    </View>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 12 : 24, gap: 18 }}>
      {error ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>{error}</Text> : null}
      <View style={{ gap: 7, maxWidth: 950 }}>
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 17, fontWeight: "600" }}>{guide.title}</Text>
        {tab === "Next step" ? <Text style={{ color: colors.foreground, lineHeight: 22 }}>{next.why}</Text> : null}
        {guide.steps.map((step, index) => <Text key={step} style={{ color: colors.foregroundMuted, lineHeight: 21 }}>{index + 1}. {step}</Text>)}
      </View>
      {tab === "Next step" ? <View style={{ gap: 16, maxWidth: 950 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          {next.tab === "Workers" ? <CompactLink label={conversationLabel} icon="MessageSquare" selected colors={colors} onPress={conversation} />
            : <CompactLink label={next.action} selected colors={colors} onPress={() => setTab(next.tab)} />}
          {next.tab !== "Workers" ? <CompactLink label={conversationLabel} icon="MessageSquare" colors={colors} onPress={conversation} /> : null}
          {workspaceId && navigation && !findOwnerInWorkspace ? <CompactLink label="Open owning workspace" colors={colors} onPress={() => { try { navigation.openWorkspace({ serverId: row.serverId, workspaceId }); } catch (cause) { setError(String(cause)); } }} /> : null}
        </View>
        <Text style={{ color: colors.foregroundMuted, lineHeight: 22 }}>After this: {next.after}</Text>
        <CompactLink label={handoff ? "Hide saved handoff" : "Read saved handoff and timestamp"} colors={colors} expanded={handoff} onPress={() => setHandoff(!handoff)} />
        {handoff ? <View style={{ gap: 8 }}><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Workflow record updated {row.updatedAt}. This saved note may not reflect the latest conversation.</Text><Text selectable style={{ color: colors.foreground, lineHeight: 22 }}>{row.next}</Text></View> : null}
      </View> : null}
      <View style={{ gap: 8 }}>
        <CompactLink label={criteria ? "Hide acceptance criteria" : "Read task acceptance criteria"} colors={colors} expanded={criteria} onPress={() => setCriteria(!criteria)} />
        {criteria ? <Text selectable style={{ color: colors.foreground, lineHeight: 22, maxWidth: 950 }}>{Array.isArray(row.entry.task.acceptanceCriteria) ? row.entry.task.acceptanceCriteria.join("\n") : row.entry.task.acceptanceCriteria || "No acceptance criteria recorded. Clarify the intended result before approving a plan."}</Text> : null}
      </View>
      {!available ? <View style={{ gap: 8 }}><Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>Actions and live evidence are unavailable until {row.hostLabel} has a fresh, complete task snapshot and its Mission Control connection is ready. Last observed: {row.observedAt}. Use Refresh task after reconnecting.</Text>{row.entry.problem ? <Text selectable style={{ color: colors.foreground }}>{row.entry.problem}</Text> : null}</View> : null}
      {row.staleReview ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>The saved review belongs to a different run or revision. Ask the worker for a fresh review; this review cannot be accepted.</Text> : null}
      {tab === "Workers" ? <View style={{ gap: 16 }}>
        {!activeWorkers.length ? <Text style={{ color: colors.foreground }}>No active worker is linked to this task. {row.coordinators.length ? "Open its coordinator below to establish the next step." : "Open the owning workspace to locate the task owner. Do not assume another agent in that workspace owns this ticket."}</Text> : null}
        {!activeWorkers.length && !row.coordinators.length && workspaceId && navigation ? <CompactLink label="Open owning workspace" colors={colors} onPress={() => navigation.openWorkspace({ serverId: row.serverId, workspaceId })} /> : null}
        {!activeWorkers.length && !row.coordinators.length && !workspaceId ? <Text style={{ color: colors.statusWarning }}>No owning workspace or conversation is verified. Ask the host orchestrator to recover the binding for task {row.entry.task.taskId} on {row.hostLabel}.</Text> : null}
        <FleetWorkerTree workers={row.workers} serverId={row.serverId} colors={colors} openAgent={openAgent} />
        {row.coordinators.map(coordinator => <CompactLink key={coordinator.agentId} label={`Open ${coordinator.name}`} colors={colors} onPress={() => openAgent(snapshot.serverId, coordinator.agentId)} />)}
        {row.queue.map(queue => <Text key={queue.coordinatorId} style={{ color: colors.foregroundMuted }}>Queue priority {queue.priority} · coordinator checks eligibility before starting</Text>)}
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Recorded stage: {row.workflow.stage} · {row.workflow.evidence}</Text>
      </View> : null}
      {tab === "Receipt" ? receipt ? <View style={{ gap: 10, maxWidth: 950 }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>{receipt.context.status}</Text><Text selectable style={{ color: colors.foreground, lineHeight: 23 }}>{receipt.text}</Text></View> : <Text style={{ color: colors.foregroundMuted }}>No resolved decision receipt has been returned for this task.</Text> : null}
      {available && "copy" in bridge ? <HostRpcProvider copy={bridge.copy}>
        {tab === "Plan" ? <View style={{ gap: 12 }}><CompactLink label="Open saved plan documents" icon="FileText" colors={colors} onPress={() => evidence()} /><TaskPlan entry={row.entry} host={row.host} colors={colors} openAgent={openAgent} /></View> : null}
        {tab === "Decision" && !row.staleReview && hasRequest ? <TaskAttention entry={row.entry} workers={row.workers.filter(worker => !worker.archivedAt)} host={row.host} colors={colors} openAgent={openAgent} /> : null}
        {tab === "Delivery" && !row.staleReview ? <TaskDelivery entry={row.entry} serverId={row.serverId} colors={colors} /> : null}
        {tab === "Evidence" ? workspaceId ? <TaskFlowDetail key={document ?? "activity"} initialDocument={document} task={row.entry.task} binding={{ serverId: row.serverId, workspaceId, taskId: row.entry.task.taskId }} online colors={colors} hostLabel={row.hostLabel} openAgent={id => openAgent(row.serverId, id)} /> : <Text style={{ color: colors.statusWarning }}>The owning workspace is not verified. Inspect the linked worker before opening evidence.</Text> : null}
        {tab === "Code review" ? workspace ? <View style={{ minHeight: Math.max(800, height - 260), flexShrink: 0, gap: 10 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Changes are from this task's workspace. Other agents may have contributed to a shared checkout.</Text>
          <MissionReview embedded sessionId={`kanban:${row.key}`} serverId={row.serverId} localServerId={row.serverId} online colors={colors} compact={compact}
            workspace={{ ...workspace, hostLabel: row.hostLabel }} onChangeWorkspace={() => setTab("Workers")}
            openWorkspace={navigation ? () => navigation.openWorkspace({ serverId: row.serverId, workspaceId: workspace.id }) : undefined}
            brief={(live, stale, selectFile) => <ReviewReport entry={row.entry} serverId={row.serverId} workspace={{ ...workspace, hostLabel: row.hostLabel }} snapshot={live} stale={stale || row.staleReview} colors={colors} selectFile={selectFile} openAgent={id => openAgent(row.serverId, id)} onEvidence={() => evidence()} />}
            readiness={(live, stale) => <ReviewReadiness entry={row.entry} serverId={row.serverId} workspaceId={workspace.id} online snapshot={live} stale={stale} complete={row.host.complete} colors={colors} onEvidence={evidence} onDecision={() => setTab("Decision")} />} />
        </View> : <Text style={{ color: colors.statusWarning }}>The task's owning workspace is unavailable. Open its worker conversation to recover the workspace before reviewing code.</Text> : null}
      </HostRpcProvider> : null}
    </ScrollView>
  </View>;
}
