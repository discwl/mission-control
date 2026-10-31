import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useHosts, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { FleetSnapshot } from "../shared/fleet";
import { captureIntake, routeIntake, type IntakeAction } from "../shared/intake";
import { CompactLink } from "./compact-link";
import { MorningCheck } from "./morning-check";
import { usePageState } from "./page-state";
type Colors = PluginSurfaceProps["theme"]["colors"];
type Pending = { requestId: string; coordinatorId: string; remoteServerId: string; workspaceId: string; title: string; acceptanceCriteria: string; action: IntakeAction };
type Receipt = { taskId: string; title: string; action: IntakeAction; completed: boolean; message: string; serverId: string; coordinatorId: string };
const actions: { id: IntakeAction; label: string; hint: string }[] = [
  { id: "backlog", label: "Save to backlog", hint: "Keep the task for later. No worker starts." },
  { id: "queue", label: "Queue for planning", hint: "Add to this coordinator’s queue. A paused heartbeat stays paused." },
  { id: "plan", label: "Plan now", hint: "Start the managed workflow at planning. Implementation waits for your plan approval." },
];
function DestinationPicker({ label, options, value, onChange, colors, disabled }: { label: string; options: { id: string; label: string; detail?: string }[]; value: string; onChange(id: string): void; colors: Colors; disabled: boolean }) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const selected = options.find(option => option.id === value);
  const shown = options.filter(option => `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  return <View style={{ gap: 6 }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`Choose ${label.toLowerCase()}`} accessibilityState={{ expanded: open, disabled }} disabled={disabled} onPress={() => { setOpen(!open); setSearch(""); }} style={{ minHeight: 44, borderWidth: 1, borderColor: open ? colors.accent : colors.border, borderRadius: 6, padding: 10, flexDirection: "row", alignItems: "center", gap: 8, opacity: disabled ? 0.6 : 1 }}>
      <Text style={{ color: colors.foreground, flex: 1 }}>{selected?.label ?? `Choose ${label.toLowerCase()}`}</Text><Icon name="ChevronDown" size={16} color={colors.foregroundMuted} />
    </Pressable>
    {open && !disabled ? <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 6, backgroundColor: colors.surface1 }}>
      <TextInput accessibilityLabel={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()}`} placeholderTextColor={colors.foregroundMuted} value={search} onChangeText={setSearch} onKeyPress={event => { if (event.nativeEvent.key === "Escape") setOpen(false); }} style={{ minHeight: 44, padding: 10, color: colors.foreground, borderBottomWidth: 1, borderBottomColor: colors.border }} />
      <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled">
        {shown.map(option => <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ checked: value === option.id }} onPress={() => { onChange(option.id); setOpen(false); }} style={({ pressed }) => ({ padding: 10, minHeight: 44, gap: 4, backgroundColor: pressed || value === option.id ? colors.surface2 : colors.surface1 })}><Text style={{ color: colors.foreground }}>{option.label}</Text>{option.detail ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{option.detail}</Text> : null}</Pressable>)}
        {!shown.length ? <Text style={{ padding: 12, color: colors.foregroundMuted }}>No available matches. Refresh host records or change your search.</Text> : null}
      </ScrollView>
    </View> : null}
  </View>;
}
export function KanbanIntake({ snapshot, colors, navigation, close, refresh, openTask }: { snapshot: FleetSnapshot; colors: Colors; navigation: PluginSurfaceProps["navigation"]; close(): void; refresh(): void; openTask(serverId: string, taskId: string): void }) {
  const hosts = useHosts(), capture = useRpc(captureIntake), route = useRpc(routeIntake);
  const prefix = `kanban-intake:${snapshot.serverId}`;
  const [mode, setMode] = usePageState<"discover" | "describe">(`${prefix}:mode`, "discover");
  const [serverId, setServerId] = usePageState(`${prefix}:host`, "");
  const [coordinatorId, setCoordinatorId] = usePageState(`${prefix}:coordinator`, "");
  const [workspaceId, setWorkspaceId] = usePageState(`${prefix}:workspace`, "");
  const [title, setTitle] = usePageState(`${prefix}:title`, ""), [requirements, setRequirements] = usePageState(`${prefix}:requirements`, "");
  const [action, setAction] = usePageState<IntakeAction>(`${prefix}:action`, "backlog");
  const [pending, setPending] = usePageState<Pending | null>(`${prefix}:pending`, null);
  const [receipts, setReceipts] = usePageState<Receipt[]>(`${prefix}:receipts`, []);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const remote = snapshot.hosts.find(host => host.serverId === serverId), liveHost = hosts.find(host => host.serverId === serverId);
  const coordinators = snapshot.coordinators.filter(item => item.remoteServerId === serverId);
  const coordinator = coordinators.find(item => item.agentId === coordinatorId) ?? (coordinators.length === 1 ? coordinators[0] : undefined);
  const workspaces = remote?.snapshot?.workspaces.filter(item => !["archived", "archiving", "failed"].includes(item.status)) ?? [];
  const workspace = workspaces.find(item => item.id === workspaceId);
  const age = Date.now() - Date.parse(remote?.snapshot?.observedAt ?? "");
  const ready = Boolean(remote?.snapshot?.complete && !remote.error && !remote.snapshot.warnings.length && age >= 0 && age <= 90_000 && liveHost?.status === "online");
  const locked = busy || Boolean(pending);
  const inputStyle = { color: colors.foreground, borderColor: colors.border, borderWidth: 1, borderRadius: 6, padding: 12, minHeight: 44 };
  async function submit() {
    if (busy || !pending && (!ready || !coordinator || !workspace)) return;
    const request = pending ?? { requestId: globalThis.crypto.randomUUID(), coordinatorId: coordinator!.agentId, remoteServerId: serverId, workspaceId, title: title.trim(), acceptanceCriteria: requirements.trim(), action };
    const parsed = captureIntake.input.safeParse(request);
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join(". ")); return; }
    setPending(request); setBusy(true); setError("");
    try {
      const result = await capture(request);
      setReceipts(current => [...current.filter(row => row.taskId !== result.taskId || row.serverId !== request.remoteServerId), { ...result, serverId: request.remoteServerId, coordinatorId: request.coordinatorId }]);
      setPending(null); setTitle(""); setRequirements(""); refresh();
    } catch (reason) { setError(`${reason instanceof Error ? reason.message : String(reason)} The request is retained. Retry the same request to avoid a duplicate task.`); }
    finally { setBusy(false); }
  }
  async function schedule(row: Receipt, next: IntakeAction) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await route({ coordinatorId: row.coordinatorId, remoteServerId: row.serverId, taskId: row.taskId, action: next });
      setReceipts(current => current.map(item => item.taskId === row.taskId && item.serverId === row.serverId ? { ...item, ...result } : item)); refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, gap: 20 }} keyboardShouldPersistTaps="handled"><View style={{ maxWidth: 900, width: "100%", gap: 20, alignSelf: "center" }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}><CompactLink label="Back to Kanban" colors={colors} onPress={close} /><Text accessibilityRole="header" style={{ fontSize: 24, fontWeight: "600", color: colors.foreground }}>Intake</Text><CompactLink label="Refresh hosts" colors={colors} onPress={refresh} disabled={busy} /></View>
    <Text style={{ color: colors.foregroundMuted, lineHeight: 21 }}>Choose a host and workspace, then discover existing work or describe something new. You decide what enters the backlog and when planning starts.</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{([{ id: "discover", label: "Discover work" }, { id: "describe", label: "Describe a task" }] as const).map(tab => <CompactLink key={tab.id} colors={colors} label={tab.label} selected={mode === tab.id} disabled={locked} onPress={() => setMode(tab.id)} />)}</View>
    <DestinationPicker label="Host" colors={colors} disabled={locked} value={serverId} options={[...snapshot.hosts].sort((a, b) => a.label.localeCompare(b.label)).map(item => ({ id: item.serverId, label: item.label, detail: item.error || !item.snapshot?.complete ? "Unavailable or incomplete — reconnect before intake" : "Managed host" }))} onChange={id => { setServerId(id); setCoordinatorId(""); setWorkspaceId(""); setError(""); }} />
    {coordinators.length > 1 ? <DestinationPicker label="Coordinator" colors={colors} disabled={locked} value={coordinator?.agentId ?? ""} options={coordinators.map(item => ({ id: item.agentId, label: item.name }))} onChange={setCoordinatorId} /> : null}
    {serverId ? <DestinationPicker label="Project / workspace" colors={colors} disabled={locked || !ready} value={workspaceId} options={workspaces.map(item => ({ id: item.id, label: `${item.projectName} / ${item.name}`, detail: item.id }))} onChange={setWorkspaceId} /> : null}
    {serverId && !ready ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>This host is offline, incomplete or its records are stale. Reconnect and refresh before starting intake. {remote?.error}</Text> : null}
    {serverId && !coordinator ? <Text style={{ color: colors.statusWarning }}>Choose a coordinator for this host. If none is listed, bind its orchestrator before creating or scheduling tasks.</Text> : null}
    {workspace ? <Text style={{ color: colors.foreground, fontWeight: "600" }}>Destination: {remote?.label} · {workspace.projectName} / {workspace.name}</Text> : null}
    {mode === "discover" && ready && workspace && coordinator && liveHost ? <MorningCheck coordinatorId={coordinator.agentId} key={`${serverId}:${workspaceId}`} ownServerId={serverId} host={liveHost} workspace={workspace} colors={colors} navigation={navigation} openTask={id => openTask(serverId, id)} onImported={tasks => {
      setReceipts(current => [...current, ...tasks.filter(task => !current.some(row => row.serverId === serverId && row.taskId === task.taskId)).map(task => ({ ...task, serverId, coordinatorId: coordinator.agentId, action: "backlog" as const, completed: true, message: "Saved to backlog. No worker started." }))]); refresh();
    }} /> : null}
    {mode === "describe" ? <View style={{ gap: 12 }}>
      <Text accessibilityRole="header" style={{ fontSize: 18, fontWeight: "600", color: colors.foreground }}>What needs to change?</Text>
      <TextInput accessibilityLabel="Task title" placeholder="A short task title" placeholderTextColor={colors.foregroundMuted} value={pending?.title ?? title} editable={!locked} onChangeText={setTitle} maxLength={200} style={inputStyle} />
      <TextInput accessibilityLabel="Task description and success criteria" placeholder="Describe the problem, expected behavior and how we’ll know it works. Paste links if useful; a ticket is not required." placeholderTextColor={colors.foregroundMuted} value={pending?.acceptanceCriteria ?? requirements} editable={!locked} onChangeText={setRequirements} maxLength={4000} multiline style={{ ...inputStyle, minHeight: 150, textAlignVertical: "top" }} />
      {actions.map(choice => <Pressable key={choice.id} accessibilityRole="radio" accessibilityState={{ checked: (pending?.action ?? action) === choice.id, disabled: locked }} disabled={locked} onPress={() => setAction(choice.id)} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, minHeight: 44 }}><Icon name={(pending?.action ?? action) === choice.id ? "CircleDot" : "Circle"} size={18} color={(pending?.action ?? action) === choice.id ? colors.accent : colors.foregroundMuted} /><View style={{ flex: 1, gap: 4 }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>{choice.label}</Text><Text style={{ color: colors.foregroundMuted }}>{choice.hint}</Text></View></Pressable>)}
      {pending ? <Text style={{ color: colors.statusWarning }}>Awaiting confirmation for the saved request on {snapshot.hosts.find(host => host.serverId === pending.remoteServerId)?.label ?? pending.remoteServerId}. Retrying uses the same task ID.</Text> : null}
      <CompactLink label={busy ? "Saving…" : pending ? "Retry saved request" : actions.find(choice => choice.id === action)!.label} colors={colors} selected disabled={busy || !pending && (!ready || !workspace || !coordinator || !title.trim() || !requirements.trim())} onPress={() => void submit()} />
    </View> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>{error}</Text> : null}
    {receipts.length ? <View style={{ gap: 12, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 20 }}><Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 18, fontWeight: "600" }}>Saved tasks · choose what happens next</Text>{receipts.map(row => <View key={`${row.serverId}:${row.taskId}`} style={{ gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>{snapshot.hosts.find(host => host.serverId === row.serverId)?.label} · {row.title}</Text><Text accessibilityLiveRegion="polite" style={{ color: row.completed ? colors.foregroundMuted : colors.statusWarning }}>{row.message}</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><CompactLink label="Open task" colors={colors} onPress={() => openTask(row.serverId, row.taskId)} />{row.action !== "plan" || !row.completed ? <><CompactLink label="Queue for planning" colors={colors} disabled={busy} onPress={() => void schedule(row, "queue")} /><CompactLink label="Plan now" colors={colors} disabled={busy} onPress={() => void schedule(row, "plan")} /></> : null}<CompactLink label="Dismiss receipt" colors={colors} disabled={busy} onPress={() => setReceipts(current => current.filter(item => item !== row))} /></View></View>)}</View> : null}
    <View style={{ gap: 8, paddingTop: 12 }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>You can also start from chat</Text><Text selectable style={{ color: colors.foregroundMuted, lineHeight: 21 }}>In the host coordinator’s chat, use /mc discover or /mc discovery workspaces. To describe a task: /mc save task in &lt;workspace&gt; | &lt;title&gt; | &lt;requirements&gt;. Use queue task or plan task instead of save task to choose the next step. Telegram uses these same commands in the linked coordinator topic.</Text></View>
  </View></ScrollView>;
}
