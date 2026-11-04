import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { FleetCoordinator, FleetSnapshot } from "../shared/fleet";
import { managedTasks } from "../shared/fleet-model";
import { controlPipeline, startPipeline } from "../shared/pipeline";
import { CompactLink } from "./compact-link";
import { PipelineIntakeForm } from "./pipeline-intake";
import { formatDateTime } from "./date-time";
import { AgentPolicyEditor, TaskAgentPolicyEditor } from "./agent-policy";
import { PipelineReviewEvidence } from "./pipeline-review";
import { RemoteActionDeliveryCard } from "./action-delivery";
type Colors = PluginSurfaceProps["theme"]["colors"];
export function PipelineBoard({ snapshot, coordinators, colors, busy, act, openAgent, openTask }: {
  snapshot: FleetSnapshot; coordinators: FleetCoordinator[]; colors: Colors; busy: boolean;
  act: (key: string, work: () => Promise<unknown>) => void; openAgent: (serverId: string, agentId: string) => void; openTask: (coordinatorId: string, taskId: string) => void;
}) {
  const start = useRpc(startPipeline); const control = useRpc(controlPipeline);
  const available = (id: string) => snapshot.hosts.some(host => host.serverId === id && host.snapshot?.complete && !host.error);
  const ordered = [...coordinators].sort((a, b) => Number(available(b.remoteServerId)) - Number(available(a.remoteServerId)) || a.hostLabel.localeCompare(b.hostLabel) || a.name.localeCompare(b.name));
  const [coordinatorId, setCoordinatorId] = useState(() => ordered[0]?.agentId ?? ""); const [search, setSearch] = useState("");
  const [workflowMode, setWorkflowMode] = useState<"manual" | "automatic">("automatic");
  const [deliveryKind, setDeliveryKind] = useState<"code" | "actions" | "report">("code");
  const coordinator = ordered.find(item => item.agentId === coordinatorId) ?? ordered[0];
  const host = snapshot.hosts.find(item => item.serverId === coordinator?.remoteServerId)?.snapshot;
  const owned = coordinator && host ? new Set(managedTasks(snapshot.serverId, coordinator, host).map(item => item.task.taskId)) : new Set<string>();
  const candidates = host?.tasks.filter(item => !["closed", "delivered"].includes(item.task.status) && !item.task.pullRequest && (!item.run || owned.has(item.task.taskId)) && item.task.title.toLowerCase().includes(search.toLowerCase())) ?? [];
  const rows = snapshot.state.pipelines.filter(row => coordinators.some(item => item.agentId === row.coordinatorId));
  const card = { backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 9, padding: 16, gap: 10 };
  const buttonRow = { flexDirection: "row", flexWrap: "wrap", gap: 8 } as const;
  const phaseNames = { plan: "Planning", "plan-review": "Independent plan check", execute: "Implementation", validate: "Validation", review: "Independent reviews", fix: "Fixes", approval: "Your review", delivery: "Final authorization" };
  return <View style={{ gap: 16 }}>
    <View style={card}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontWeight: "700", fontSize: 20 }}>Run a task</Text>
      <Text style={{ color: colors.foreground }}>A second model checks the plan, then two independent models review the validated result. You answer unresolved questions and authorize the final publication or prepared actions.</Text>
      <Text style={{ color: colors.foregroundMuted }}>Plan → Plan check → Build → Validate → Review A → Review B → Ready for you</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Runs while this computer and Paseo are awake, including weekends. Checks every 30 seconds; stage dispatches at least 5 minutes apart, up to 24 per day. Up to two plan repairs and two implementation repairs. Existing tasks keep their plans, history, workspaces and PRs.</Text>
    </View>
    {!rows.length ? <Text style={{ color: colors.foregroundMuted }}>No task runners yet. Start with one task below.</Text> : null}
    {rows.map(row => {
      const owner = snapshot.coordinators.find(item => item.agentId === row.coordinatorId);
      const remote = snapshot.hosts.find(item => item.serverId === row.remoteServerId);
      const task = remote?.snapshot?.tasks.find(item => item.task.taskId === row.taskId);
      const change = (action: "pause" | "resume" | "stop") => act(row.id, () => control({ id: row.id, action, expectedRevision: snapshot.state.revision }));
      const phaseLabel = row.mode === "done" ? (row.deliveryKind === "report" ? "Report complete" : row.deliveryKind === "actions" ? "Actions complete" : "Delivery complete") : phaseNames[row.stage];
      return <View key={row.id} style={{ ...card, borderLeftWidth: 3, borderLeftColor: ["blocked", "waiting"].includes(row.mode) ? colors.statusWarning : colors.accent }}>
        <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "600" }}>{task?.task.title ?? row.title}</Text>
        <Text style={{ color: colors.foregroundMuted }}>{owner?.hostLabel ?? remote?.label ?? "Host unavailable"} · {owner?.name ?? "Coordinator unavailable"}</Text>
        <Text style={{ color: ["blocked", "waiting"].includes(row.mode) ? colors.statusWarning : colors.accent }}>{phaseLabel} · {row.mode === "blocked" ? "Needs attention" : row.mode === "ready" ? "Ready for you" : row.mode}</Text>
        <Text style={{ color: colors.foreground }}>{row.message}</Text>
        {remote?.error ? <Text style={{ color: colors.statusWarning }}>Host is unavailable. Future stages wait for its connection.</Text> : null}
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{row.workflowMode === "automatic" ? `Automatic · ${row.planRepairs ?? 0}/2 plan repairs · ` : "Manual approvals · "}{row.repairs}/2 implementation repairs · Updated {formatDateTime(row.updatedAt)}</Text>
        {row.workflowMode === "automatic" && row.deliveryKind !== "code" && row.stage === "delivery" ? <RemoteActionDeliveryCard serverId={row.remoteServerId} taskId={row.taskId} actorId="human-ui" colors={colors} /> : null}
        <View style={buttonRow}>
          {row.lastWorker ? <CompactLink label="Open current stage agent" colors={colors} onPress={() => openAgent(row.remoteServerId, row.lastWorker!.agentId)} /> : null}
          <CompactLink label="Open task and decisions" colors={colors} disabled={!task} onPress={() => openTask(row.coordinatorId, row.taskId)} />
          <CompactLink label="Open coordinator" colors={colors} onPress={() => openAgent(snapshot.serverId, row.coordinatorId)} />
          {row.workflowMode !== "automatic" && ["paused", "blocked", "waiting"].includes(row.mode) ? <CompactLink label="Switch to automatic plan check and two reviews" colors={colors} disabled={busy || Boolean(row.pending) || !remote?.snapshot?.complete} onPress={() => act(row.id, () => control({ id: row.id, action: "adopt-automatic", expectedRevision: snapshot.state.revision }))} /> : null}
          {!["stopped", "done"].includes(row.mode) ? <>
            <CompactLink label={row.mode === "paused" || row.mode === "blocked" ? "Resume after checking" : "Pause future stages"} colors={colors} disabled={busy || Boolean(row.pending)} onPress={() => change(row.mode === "paused" || row.mode === "blocked" ? "resume" : "pause")} />
            <CompactLink label="Stop this runner" colors={colors} disabled={busy} onPress={() => change("stop")} />
          </> : null}
        </View>
        {task?.run ? <PipelineReviewEvidence serverId={row.remoteServerId} workspaceId={task.run.workspaceId} taskId={row.taskId} pendingRequestId={row.pending?.requestId} colors={colors} openAgent={openAgent} /> : null}
        {task ? <TaskAgentPolicyEditor key={`${row.remoteServerId}:${row.taskId}`} serverId={row.remoteServerId} projectId={task.task.projectId} taskId={row.taskId} colors={colors} /> : null}
        {row.pending ? <View style={{ gap: 8 }}>
          <Text selectable style={{ color: colors.statusWarning }}>Check dispatch {row.pending.requestId} in its remote stage worker, shown above or under the coordinator's native Subagents. Legacy messages and draft PR previews go to the coordinator. Confirm whether it arrived; this stays paused after your answer.</Text>
          <View style={buttonRow}>{(["sent", "not_sent"] as const).map(delivery => <CompactLink key={delivery} label={delivery === "sent" ? "I checked: message was delivered" : "I checked: message was not delivered"} colors={colors} disabled={busy} onPress={() => act(row.id, () => control({ id: row.id, action: "acknowledge", requestId: row.pending!.requestId, delivery, expectedRevision: snapshot.state.revision }))} />)}</View>
        </View> : null}
      </View>;
    })}
    <View style={card}>
      <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "600" }}>Start one task</Text>
      <View style={buttonRow}>{ordered.map(item => <CompactLink key={item.agentId} accessibilityLabel={`${item.hostLabel} · ${item.name}`} label={`${item.hostLabel} · ${item.name.length > 45 ? `${item.name.slice(0, 45)}…` : item.name}`} colors={colors} selected={coordinator?.agentId === item.agentId} onPress={() => setCoordinatorId(item.agentId)} />)}</View>
      <Text style={{ color: colors.foreground, fontWeight: "600" }}>Workflow</Text>
      <View style={buttonRow}>{(["automatic", "manual"] as const).map(value => <CompactLink key={value} label={value === "automatic" ? "Automatic plan check + two reviews" : "Human plan and review approvals"} colors={colors} selected={workflowMode === value} disabled={busy} onPress={() => { setWorkflowMode(value); if (value === "manual") setDeliveryKind("code"); }} />)}</View>
      <Text style={{ color: colors.foreground, fontWeight: "600" }}>Deliverable</Text>
      <View style={buttonRow}>{(workflowMode === "automatic" ? ["code", "actions", "report"] as const : ["code"] as const).map(value => <CompactLink key={value} label={value === "code" ? "Code and draft PR" : value === "actions" ? "Scripts or actions" : "Read-only report"} colors={colors} selected={deliveryKind === value} disabled={busy} onPress={() => setDeliveryKind(value)} />)}</View>
      <PipelineIntakeForm snapshot={snapshot} coordinator={coordinator} colors={colors} busy={busy} act={act} workflowMode={workflowMode} deliveryKind={deliveryKind} />
      {coordinator ? <AgentPolicyEditor key={coordinator.remoteServerId} serverId={coordinator.remoteServerId} label={coordinator.hostLabel} colors={colors} /> : null}
      <TextInput accessibilityLabel="Find a task for Run to draft PR" value={search} onChangeText={setSearch} placeholder="Find an existing task" placeholderTextColor={colors.foregroundMuted} style={{ padding: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 6, color: colors.foreground }} />
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>For older work, first use “adopt &lt;task ID&gt;” in this coordinator's chat, or link its worker under Supervisor. Starting an existing run preserves its workflow and deliverable; the choices above apply to tasks without a run. To switch a manual run, enroll it, pause its runner, then choose “Switch to automatic plan check and two reviews”.</Text>
      {!host ? <Text style={{ color: colors.statusWarning }}>Connect the selected host to choose a task.</Text> : null}
      {candidates.slice(0, 12).map(item => <View key={item.task.taskId} style={{ gap: 6, paddingVertical: 8, borderTopColor: colors.border, borderTopWidth: 1 }}>
        <Text style={{ color: colors.foreground }}>{item.task.title}</Text>
        <CompactLink label={item.run ? (item.run.workflowMode ?? "manual") === "manual" ? "Continue with human approvals" : "Continue existing automatic workflow" : deliveryKind === "code" ? "Run this task to draft PR" : deliveryKind === "actions" ? "Prepare reviewed actions" : "Prepare reviewed report"} colors={colors} disabled={busy || snapshot.state.paused || !host?.complete || rows.some(row => row.remoteServerId === coordinator?.remoteServerId && !["stopped", "done"].includes(row.mode))} onPress={() => act(item.task.taskId, () => start({ coordinatorId: coordinator!.agentId, remoteServerId: coordinator!.remoteServerId, taskId: item.task.taskId, workflowMode: item.run ? item.run.workflowMode ?? "manual" : workflowMode, deliveryKind: item.run ? item.run.deliveryKind ?? "code" : deliveryKind, expectedRevision: snapshot.state.revision }))} />
      </View>)}
      {host && !candidates.length ? <Text style={{ color: colors.foregroundMuted }}>No matching tasks. Create the task in Mission Control first, or adopt its existing worker.</Text> : null}
      {candidates.length > 12 ? <Text style={{ color: colors.foregroundMuted }}>Showing 12 of {candidates.length} tasks. Narrow your search.</Text> : null}
    </View>
  </View>;
}
