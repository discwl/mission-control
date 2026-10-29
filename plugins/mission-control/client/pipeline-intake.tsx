import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { FleetCoordinator, FleetSnapshot } from "../shared/fleet";
import { intakePipeline } from "../shared/pipeline";
import { CompactLink } from "./compact-link";
import { usePageState } from "./page-state";
type Intake = { requestId: string; coordinatorId: string; remoteServerId: string; workspaceId: string; title: string; acceptanceCriteria: string };
export function PipelineIntakeForm({ snapshot, coordinator, colors, busy, act }: { snapshot: FleetSnapshot; coordinator?: FleetCoordinator; colors: PluginSurfaceProps["theme"]["colors"]; busy: boolean; act: (id: string, work: () => Promise<unknown>) => void }) {
  const create = useRpc(intakePipeline);
  const [show, setShow] = useState(false); const [workspaceId, setWorkspaceId] = useState(""); const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [title, setTitle] = usePageState(`pipeline-intake:${snapshot.serverId}:title`, "");
  const [criteria, setCriteria] = usePageState(`pipeline-intake:${snapshot.serverId}:scope`, "");
  const [pending, setPending] = usePageState<Intake | null>(`pipeline-intake:${snapshot.serverId}:pending`, null);
  const remote = snapshot.hosts.find(item => item.serverId === coordinator?.remoteServerId)?.snapshot;
  const workspaces = remote?.workspaces.filter(item => !["archiving", "archived", "failed"].includes(item.status) && `${item.projectName} ${item.name}`.toLowerCase().includes(workspaceSearch.toLowerCase())) ?? [];
  const workspace = remote?.workspaces.find(item => item.id === workspaceId);
  const known = pending && snapshot.state.pipelines.find(row => row.id === pending.requestId);
  const locked = Boolean(pending);
  const inputStyle = { color: colors.foreground, borderColor: colors.border, borderWidth: 1, borderRadius: 6, padding: 10 };
  function submit() {
    if (!coordinator || !workspace && !pending) return;
    const request = pending ?? { requestId: globalThis.crypto.randomUUID(), coordinatorId: coordinator.agentId, remoteServerId: coordinator.remoteServerId, workspaceId, title: title.trim(), acceptanceCriteria: criteria.trim() };
    setPending(request);
    act(request.requestId, async () => {
      const result = await create({ ...request, expectedRevision: snapshot.state.revision });
      if (result.intake?.phase === "created") { setPending(null); setTitle(""); setCriteria(""); setShow(false); }
    });
  }
  return <View style={{ gap: 10 }}>
    <CompactLink label={show || pending ? "New task intake" : "Start from a ticket or new task"} colors={colors} expanded={show || Boolean(pending)} onPress={() => setShow(!show)} />
    {show || pending ? <View style={{ gap: 10, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 7 }}>
      <Text style={{ color: colors.foreground }}>Describe the task and what success looks like. Paste the ticket link and relevant requirements here. The coordinator will clarify gaps and show you a readable plan before building.</Text>
      {pending ? <Text style={{ color: colors.statusWarning }}>An intake request is saved. Retry this same request after a connection failure; its task ID stays the same.{known ? ` Current state: ${known.mode}.` : ""}</Text> : null}
      {!locked ? <>
        <TextInput accessibilityLabel="Find intake workspace" value={workspaceSearch} onChangeText={setWorkspaceSearch} placeholder="Find a project or workspace" placeholderTextColor={colors.foregroundMuted} style={inputStyle} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{workspaces.slice(0, 8).map(item => <CompactLink key={item.id} label={`${item.projectName} · ${item.name}`} colors={colors} selected={workspaceId === item.id} onPress={() => setWorkspaceId(item.id)} />)}</View>
        {workspaces.length > 8 ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Showing eight workspaces. Narrow your search.</Text> : null}
      </> : null}
      <Text style={{ color: colors.foregroundMuted }}>Workspace: {pending ? snapshot.hosts.find(item => item.serverId === pending.remoteServerId)?.snapshot?.workspaces.find(item => item.id === pending.workspaceId)?.name ?? pending.workspaceId : workspace ? `${coordinator?.hostLabel} · ${workspace.projectName} · ${workspace.name}` : "Choose a workspace above"}</Text>
      <TextInput accessibilityLabel="New task title" value={pending?.title ?? title} onChangeText={setTitle} editable={!locked} maxLength={200} placeholder="Task title" placeholderTextColor={colors.foregroundMuted} style={inputStyle} />
      <TextInput accessibilityLabel="Task requirements and success checks" value={pending?.acceptanceCriteria ?? criteria} onChangeText={setCriteria} editable={!locked} multiline maxLength={4000} placeholder="Problem, ticket link, expected behavior and success checks" placeholderTextColor={colors.foregroundMuted} style={{ ...inputStyle, minHeight: 140, textAlignVertical: "top" }} />
      <CompactLink label={pending ? "Check and retry this same intake" : "Create task and prepare its plan"} colors={colors} disabled={busy || snapshot.state.paused || !pending && (!workspace || !title.trim() || !criteria.trim() || !remote?.complete)} onPress={submit} />
      {known ? <CompactLink label="Clear this form; keep the saved runner" colors={colors} disabled={busy} onPress={() => { setPending(null); setTitle(""); setCriteria(""); setShow(false); }} /> : null}
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Creating a task does not approve its plan or authorize publishing.</Text>
    </View> : null}
  </View>;
}
