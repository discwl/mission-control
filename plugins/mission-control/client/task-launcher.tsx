import { CompactLink } from "./compact-link";
import { getPaseoClient, useHosts, useRpc as useLocalRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { readFleet } from "../shared/fleet";
import { startPipeline } from "../shared/pipeline";
import { findCoordinatingFleet } from "./coordinating-fleet";
import { listCopies } from "./host-bridge";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { BranchType } from "../shared/branch-names";
import { getTaskLaunch, launchTask, type TaskBinding } from "../shared/launch";
import { formatDateTime } from "./date-time";
import { ProviderIcon } from "./provider-icons";
import { findAgent, useRoster } from "./roster";
import { SubagentContextLink, useTaskTitles } from "./subagents";

type Colors = PluginSurfaceProps["theme"]["colors"];
type Props = { binding: TaskBinding; colors: Colors; navigation?: PluginSurfaceProps["navigation"] };
type Choice = { id: string; label: string; description?: string; warn?: boolean };
const stages = ["intake", "plan", "execute", "validate", "review", "fix", "delivery", "handoff"];
const titles: Record<string, string> = { intake: "Intake", plan: "Plan", execute: "Build", validate: "Checks", review: "Review", fix: "Fixes", delivery: "Delivery", handoff: "Handoff" };

export function TaskLauncher({ binding, colors, navigation }: Props) {
  const readStatus = useRpc(getTaskLaunch);
  const dispatch = useRpc(launchTask);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  // Null means the model's default effort and the provider's default permission mode.
  const [effort, setEffort] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [pickingModel, setPickingModel] = useState(false);
  // A new task gets its own worktree by default, so its changes stay separate and reviewable.
  const [isolate, setIsolate] = useState(true);
  // Used only when the branch-name template has {type} and the ticket doesn't say.
  const [branchType, setBranchType] = useState<BranchType>("feature");
  const [modelSearch, setModelSearch] = useState("");
  const query = useQuery({ queryKey: ["mission-control", "launch", binding.serverId, binding.workspaceId, binding.taskId], queryFn: () => readStatus(binding), refetchInterval: busy ? false : 5_000, retry: false });
  const status = query.data;
  // A new task on a host that an orchestrator chat manages starts in the automatic workflow, through the task runner of
  // the Mission Control copy that owns that orchestrator. This view may be drawn by the task's own host, so the lookup
  // also asks the app's other copies (the bridge). The manual Start stays only where no orchestrator manages the host.
  const readLocalFleet = useLocalRpc(readFleet);
  const startRunner = useLocalRpc(startPipeline);
  const fleet = useQuery({ queryKey: ["mission-control", "launch-fleet", binding.serverId], queryFn: () => findCoordinatingFleet(binding.serverId, () => readLocalFleet({}), listCopies()),
    enabled: status?.action === "start", staleTime: 15_000, refetchInterval: 15_000, retry: false });
  const coordinators = fleet.data?.managed ? fleet.data.fleet.coordinators.filter(item => item.remoteServerId === binding.serverId) : [];
  const runner = fleet.data?.fleet.state.pipelines.find(row => row.remoteServerId === binding.serverId && row.taskId === binding.taskId && !["stopped", "done"].includes(row.mode));
  const automaticStart = status?.action === "start" && fleet.isSuccess && (coordinators.length > 0 || Boolean(runner));
  const checkingStart = status?.action === "start" && fleet.isPending;
  // A failed lookup offers no start at all; it never falls back to the manual workflow.
  const lookupFailure = status?.action === "start" && fleet.isError ? (fleet.error instanceof Error ? fleet.error.message : String(fleet.error)) : null;
  // The manual launcher's model and permission pickers load only when this task really starts manually.
  const manualStart = status?.action === "start" && fleet.isSuccess && !automaticStart;
  const [deliveryKind, setDeliveryKind] = useState<"code" | "actions" | "report">("code");
  const [coordinatorId, setCoordinatorId] = useState<string | null>(null);
  const coordinator = coordinators.find(item => item.agentId === coordinatorId) ?? coordinators[0];
  // A task agent that another agent started says whose it is.
  const online = useHosts().some(candidate => candidate.serverId === binding.serverId && candidate.status === "online");
  const roster = useRoster(binding.serverId, online && Boolean(status?.agent));
  const taskTitles = useTaskTitles(binding.serverId, binding.serverId);
  const parentAgentId = status?.agent && roster.data ? findAgent(roster.data, status.agent.id)?.parentAgentId ?? null : null;
  const workspace = useQuery({
    queryKey: ["mission-control", "catalog-workspace", binding.serverId, binding.workspaceId],
    queryFn: async () => {
      const value = await getPaseoClient(binding.serverId).workspaces.ref(binding.workspaceId).refresh();
      if (!value?.workspaceDirectory || value.archivingAt) throw new Error("The task workspace is unavailable for model discovery.");
      return value.workspaceDirectory;
    },
    enabled: online && manualStart, staleTime: 60_000, retry: false,
  });
  const cwd = workspace.data;
  const providers = useQuery({ queryKey: ["mission-control", "launch-providers", binding.serverId], queryFn: () => getPaseoClient(binding.serverId).providers.listAvailable(), enabled: manualStart, staleTime: 60_000, retry: false });
  const available = providers.data?.providers.filter(entry => entry.available) ?? [];
  const chosenProvider = available.find(entry => entry.provider === provider)?.provider ?? available.find(entry => entry.provider === "codex")?.provider ?? available[0]?.provider;
  const models = useQuery({ queryKey: ["mission-control", "launch-models", binding.serverId, binding.workspaceId, cwd, chosenProvider], queryFn: () => getPaseoClient(binding.serverId).providers.listModels(chosenProvider!, { cwd: cwd! }), enabled: manualStart && Boolean(chosenProvider && cwd) && !workspace.isError, staleTime: 60_000, retry: false });
  const choices = models.data?.models ?? [];
  const chosenModel = choices.find(entry => entry.id === model) ?? choices.find(entry => entry.isDefault) ?? choices[0];
  const efforts = chosenModel?.thinkingOptions ?? [];
  const chosenEffort = efforts.find(entry => entry.id === effort) ?? efforts.find(entry => entry.id === chosenModel?.defaultThinkingOptionId) ?? efforts.find(entry => entry.isDefault);
  const modes = useQuery({ queryKey: ["mission-control", "launch-modes", binding.serverId, binding.workspaceId, cwd, chosenProvider], queryFn: () => getPaseoClient(binding.serverId).providers.listModes(chosenProvider!, { cwd: cwd! }), enabled: manualStart && Boolean(chosenProvider && cwd) && !workspace.isError, staleTime: 60_000, retry: false });
  const permissionModes = modes.data?.modes ?? [];
  const chosenMode = permissionModes.find(entry => entry.id === mode) ?? null;
  const button = { minHeight: 44, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 7, justifyContent: "center" as const, borderWidth: 1, borderColor: colors.border };
  const failure = error || (query.error instanceof Error ? query.error.message : null);
  const catalogFailure = workspace.error || providers.error || models.error || modes.error || providers.data?.error || models.data?.error || modes.data?.error;
  const branch = status?.action === "start" && status.canIsolate && isolate ? status.branch : null;
  const branchOption = branch && branch.options.length > 1 ? branch.options.find(entry => entry.type === branchType) : branch?.options[0];
  const branchProblem = branch ? branch.problem ?? branchOption?.problem ?? (branchOption ? null : "The task's branch name is unknown. Refresh this task.") : null;
  async function startAutomatic() {
    if (!coordinator || !fleet.data || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const input = { coordinatorId: coordinator.agentId, remoteServerId: binding.serverId, taskId: binding.taskId, workflowMode: "automatic" as const, deliveryKind, expectedRevision: fleet.data.fleet.state.revision };
      // The runner belongs to the copy whose orchestrator manages this host: this one, or the coordinating computer's.
      if (fleet.data.copy) await fleet.data.copy.rpc(startPipeline.name, input);
      else await startRunner(input);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setBusy(false); void fleet.refetch(); void query.refetch(); }
  }

  async function launch() {
    if (!status || pending.current || query.isError) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const next = await dispatch({
        ...binding, expectedRevision: status.revision,
        ...(status.action === "start" && chosenModel ? { provider: `${chosenProvider}/${chosenModel.id}` } : {}),
        ...(status.action === "start" && chosenEffort ? { thinkingOptionId: chosenEffort.id } : {}),
        ...(status.action === "start" && chosenMode ? { modeId: chosenMode.id } : {}),
        ...(status.action === "start" && status.canIsolate ? { isolate } : {}),
        ...(branchOption ? { branch: branchOption.name, ...(branch!.options.length > 1 && branchOption.type ? { branchType: branchOption.type } : {}) } : {}),
      });
      // Keep this panel visible so the accepted dispatch and run can be inspected.
      await query.refetch();
      // While the launch is still starting, any error belongs to an earlier attempt.
      if (next.action !== "starting" && next.launch?.error) setError(next.launch.error);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      // The server replies before Paseo's RPC timeout, so a timeout here means a slow host, not a failed launch.
      if (!message.startsWith("Plugin RPC timed out")) setError(message);
      await query.refetch();
    } finally { pending.current = false; setBusy(false); }
  }
  function openAgent() {
    const agentId = status?.agent?.id ?? status?.launch?.agentId;
    if (!agentId || !navigation) return;
    try { const target = { serverId: binding.serverId, agentId, focusHost: true }; navigation.openAgent(target); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  return <View style={{ gap: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 9, padding: 12, backgroundColor: colors.surface1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 16 }}>Agent workflow</Text>
      <CompactLink colors={colors} label={"Refresh"} accessibilityRole="button" accessibilityLabel="Refresh task launch" disabled={busy} onPress={() => { setError(null); void query.refetch(); }} />
    </View>
    {query.isPending ? <Text style={{ color: colors.foregroundMuted }}>Checking task and workspace…</Text> : null}
    {failure ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 13 }}>{failure}</Text> : null}
    {status ? <>
      <Text style={{ color: status.action === "blocked" ? colors.statusWarning : colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{status.message}</Text>
      {status.worktree ? <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Text style={{ color: colors.foreground, fontSize: 12 }}>Runs in its own worktree · branch <Text style={{ fontFamily: "monospace" }}>{status.worktree.branch}</Text></Text>
        {navigation ? <CompactLink colors={colors} label={"Open worktree →"} accessibilityRole="button" onPress={() => { try { const target = { serverId: binding.serverId, workspaceId: status.worktree!.workspaceId, focusHost: true }; navigation.openWorkspace(target); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }} /> : null}
      </View> : null}
      {status.run ? <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
          {stages.map(stage => <Text key={stage} style={{ color: status.run!.stage === stage ? colors.accent : colors.foregroundMuted, fontWeight: status.run!.stage === stage ? "700" : "400", fontSize: 11, padding: 5, borderRadius: 4, backgroundColor: status.run!.stage === stage ? colors.surface2 : "transparent" }}>{titles[stage]}</Text>)}
        </View>
        <Text style={{ color: colors.foreground, fontSize: 13 }}>{titles[status.run.stage]} · {status.run.outcome.replaceAll("_", " ")}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>Next: {status.run.nextAction}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Updated {formatDateTime(status.run.updatedAt)}</Text>
      </View> : null}
      {status.agent ? <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <ProviderIcon provider={status.agent.provider} color={colors.foregroundMuted} />
        <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: 13, flex: 1 }}>{status.agent.name}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{status.agent.status}</Text>
      </View> : null}
      {parentAgentId && roster.data ? <SubagentContextLink parentAgentId={parentAgentId} roster={roster.data} taskTitles={taskTitles} colors={colors} canNavigate={Boolean(navigation)}
        openAgent={agentId => { try { const target = { serverId: binding.serverId, agentId, focusHost: true }; navigation?.openAgent(target); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }} /> : null}
      {checkingStart ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Checking how this task starts…</Text> : null}
      {lookupFailure ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 17 }}>{lookupFailure}</Text> : null}
      {automaticStart ? <View style={{ gap: 9 }}>
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>Automatic workflow</Text>
        {runner ? <>
          <Text style={{ color: colors.foreground, fontSize: 13 }}>Started · {runner.stage} · {runner.mode}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{runner.message}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Follow it in Orchestrator → Run a task. Questions and the final publishing decision come to you there and in Needs you.</Text>
        </> : <>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Plan → independent plan check by a second model → build → validation → two independent reviews → your final authorization. A code task first gets its own worktree and branch. The host's phase profiles choose the models; tasks wait in the host's queue in the order they start.</Text>
          {coordinators.length > 1 ? <ChoiceRow label="Orchestrator" choices={coordinators.map(item => ({ id: item.agentId, label: item.name.length > 40 ? `${item.name.slice(0, 40)}…` : item.name }))} selected={coordinator?.agentId ?? null} onSelect={setCoordinatorId} disabled={busy} colors={colors} button={button} /> : null}
          <ChoiceRow label="Deliverable" choices={[{ id: "code", label: "Code and draft PR" }, { id: "actions", label: "Scripts or actions" }, { id: "report", label: "Read-only report" }]} selected={deliveryKind} onSelect={id => setDeliveryKind(id === "actions" ? "actions" : id === "report" ? "report" : "code")} disabled={busy} colors={colors} button={button} />
          <Pressable accessibilityRole="button" disabled={busy || query.isError || !coordinator || fleet.data?.fleet.state.paused} onPress={() => void startAutomatic()} style={{ ...button, alignSelf: "flex-start", backgroundColor: colors.accent, opacity: busy || query.isError || !coordinator || fleet.data?.fleet.state.paused ? 0.5 : 1 }}>
            <Text style={{ color: colors.accentForeground, fontWeight: "600" }}>{busy ? "Starting…" : "Start automatic workflow"}</Text>
          </Pressable>
          {fleet.data?.fleet.state.paused ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Fleet wake-ups are paused. Resume them in Orchestrator before starting.</Text> : null}
        </>}
      </View> : null}
      {manualStart ? <View style={{ gap: 9 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>No orchestrator in this Paseo app manages this host, so this task starts in the manual workflow: you approve its plan and code review. If an orchestrator on your coordinating computer manages this host, start the task there (Mission Control or the orchestrator's chat) to use the automatic workflow.</Text>
        {status.canIsolate ? <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: isolate }} accessibilityLabel="Work in its own worktree" disabled={busy} onPress={() => setIsolate(!isolate)}
          style={{ flexDirection: "row", alignItems: "flex-start", gap: 9, minHeight: 44, paddingVertical: 4 }}>
          <View style={{ width: 18, height: 18, marginTop: 2, borderRadius: 4, borderWidth: 1, borderColor: isolate ? colors.accent : colors.border, backgroundColor: isolate ? colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
            {isolate ? <Text style={{ color: colors.accentForeground, fontSize: 12, lineHeight: 14 }}>✓</Text> : null}
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>Work in its own worktree</Text>
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Creates a branch in a separate folder and workspace, so this task's changes stay apart from other agents' and Review shows only its work. Uncommitted changes here are not copied.</Text>
          </View>
        </Pressable> : null}
        {branch ? <View style={{ gap: 6, paddingLeft: 27 }}>
          {branch.options.length > 1 ? <ChoiceRow label="Branch type" choices={branch.options.map(entry => ({ id: entry.type ?? "", label: entry.type === "bugfix" ? "Bugfix" : "Feature" }))} selected={branchOption?.type ?? null} onSelect={id => setBranchType(id === "bugfix" ? "bugfix" : "feature")} disabled={busy} colors={colors} button={button} /> : null}
          {branchOption ? <Text selectable style={{ color: colors.foreground, fontSize: 12 }}>Branch <Text style={{ fontFamily: "monospace" }}>{branchOption.name}</Text></Text> : null}
          {branch.note ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{branch.note}</Text> : null}
          {branchProblem ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 17 }}>{branchProblem} Change the branch name template in Settings → Plugins → Mission Control → Branch names, or clear “Work in its own worktree”.</Text> : null}
        </View> : null}
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>New agent</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {available.map(entry => <Pressable key={entry.provider} accessibilityRole="button" accessibilityState={{ selected: chosenProvider === entry.provider }} disabled={busy} onPress={() => { setProvider(entry.provider); setModel(null); setEffort(null); setMode(null); setPickingModel(false); }} style={{ ...button, borderColor: chosenProvider === entry.provider ? colors.accent : colors.border }}><Text style={{ color: colors.foreground, fontSize: 12 }}>{entry.provider}</Text></Pressable>)}
        </View>
        {workspace.isPending || providers.isPending || models.isFetching ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Loading available models…</Text> : null}
        {catalogFailure ? <Text style={{ color: colors.statusDanger, fontSize: 12 }}>{catalogFailure instanceof Error ? catalogFailure.message : String(catalogFailure)}</Text> : null}
        {!providers.isPending && !available.length ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>No available providers. Check this host's Paseo provider settings.</Text> : null}
        {chosenModel ? <Pressable accessibilityRole="button" accessibilityLabel="Choose task agent model" accessibilityState={{ expanded: pickingModel }} disabled={busy} onPress={() => setPickingModel(!pickingModel)} style={button}><Text style={{ color: colors.foreground, fontSize: 13 }}>Model: {chosenModel.label} ▾</Text></Pressable> : null}
        {pickingModel ? <View style={{ gap: 6 }}>
          <TextInput accessibilityLabel="Find a task agent model" placeholder="Find a model" placeholderTextColor={colors.foregroundMuted} value={modelSearch} onChangeText={setModelSearch} style={{ color: colors.foreground, borderColor: colors.border, borderWidth: 1, borderRadius: 6, minHeight: 44, padding: 8 }} />
          <ScrollView nestedScrollEnabled style={{ maxHeight: 200 }}>
            {choices.filter(entry => `${entry.label} ${entry.id}`.toLowerCase().includes(modelSearch.toLowerCase())).map(entry => <Pressable key={entry.id} accessibilityRole="button" accessibilityState={{ selected: chosenModel?.id === entry.id }} onPress={() => { setModel(entry.id); setEffort(null); setPickingModel(false); }} style={button}><Text style={{ color: colors.foreground, fontSize: 12 }}>{entry.label}</Text></Pressable>)}
          </ScrollView>
        </View> : null}
        {efforts.length ? <ChoiceRow label="Effort" choices={efforts} selected={chosenEffort?.id ?? null} onSelect={setEffort} disabled={busy} colors={colors} button={button} /> : null}
        {permissionModes.length ? <ChoiceRow label="Permissions" hint={chosenMode ? chosenMode.description : "Provider default unless you pick one."} choices={permissionModes.map(entry => ({ ...entry, warn: entry.colorTier === "dangerous" }))} selected={chosenMode?.id ?? null} onSelect={id => setMode(id === chosenMode?.id ? null : id)} disabled={busy} colors={colors} button={button} /> : null}
      </View> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {["resume", "recover"].includes(status.action) || manualStart ? <Pressable accessibilityRole="button" disabled={busy || query.isError || (status.action === "start" && (!chosenModel || Boolean(catalogFailure) || models.isFetching || Boolean(branchProblem)))} onPress={() => void launch()} style={{ ...button, backgroundColor: colors.accent, opacity: busy || query.isError || (status.action === "start" && (!chosenModel || Boolean(catalogFailure) || models.isFetching || Boolean(branchProblem))) ? 0.5 : 1 }}><Text style={{ color: colors.accentForeground, fontWeight: "600" }}>{busy ? "Starting…" : status.action === "start" ? "Start task" : status.action === "resume" ? "Resume task" : "Continue launch"}</Text></Pressable> : null}
        {(status.agent || status.launch) && navigation ? <CompactLink colors={colors} label={status.agent ? `Open workflow agent: ${status.agent.name}` : "Open launch agent"} accessibilityRole="button" onPress={openAgent} /> : null}
      </View>
      {status.launch ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{status.launch.phase === "sent" ? "Prompt accepted" : status.launch.phase === "sending" ? "Delivery unconfirmed" : "Preparing launch"} · {formatDateTime(status.launch.updatedAt)}</Text> : null}
    </> : null}
  </View>;
}

function ChoiceRow({ label, hint, choices, selected, onSelect, disabled, colors, button }: { label: string; hint?: string; choices: Choice[]; selected: string | null; onSelect: (id: string) => void; disabled: boolean; colors: Colors; button: object }) {
  return <View style={{ gap: 6 }}>
    <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {choices.map(choice => <Pressable key={choice.id} accessibilityRole="button" accessibilityLabel={`${label}: ${choice.label}`} accessibilityState={{ selected: selected === choice.id }} disabled={disabled} onPress={() => onSelect(choice.id)} style={{ ...button, borderColor: selected === choice.id ? colors.accent : colors.border }}>
        <Text style={{ color: choice.warn ? colors.statusWarning : colors.foreground, fontSize: 12 }}>{choice.label}</Text>
      </Pressable>)}
    </View>
    {hint ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{hint}</Text> : null}
  </View>;
}
