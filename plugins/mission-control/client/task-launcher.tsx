import { CompactLink } from "./compact-link";
import { useHosts, usePaseo, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
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
  const paseo = usePaseo();
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
  // A task agent that another agent started says whose it is.
  const online = useHosts().some(candidate => candidate.serverId === binding.serverId && candidate.status === "online");
  const roster = useRoster(binding.serverId, online && Boolean(status?.agent));
  const taskTitles = useTaskTitles(binding.serverId, binding.serverId);
  const parentAgentId = status?.agent && roster.data ? findAgent(roster.data, status.agent.id)?.parentAgentId ?? null : null;
  const providers = useQuery({ queryKey: ["mission-control", "launch-providers", binding.serverId], queryFn: () => paseo.providers.listAvailable(), enabled: status?.action === "start", staleTime: 60_000, retry: false });
  const available = providers.data?.providers.filter(entry => entry.available) ?? [];
  const chosenProvider = available.find(entry => entry.provider === provider)?.provider ?? available.find(entry => entry.provider === "codex")?.provider ?? available[0]?.provider;
  const models = useQuery({ queryKey: ["mission-control", "launch-models", binding.serverId, chosenProvider], queryFn: () => paseo.providers.listModels(chosenProvider!), enabled: status?.action === "start" && Boolean(chosenProvider), staleTime: 60_000, retry: false });
  const choices = models.data?.models ?? [];
  const chosenModel = choices.find(entry => entry.id === model) ?? choices.find(entry => entry.isDefault) ?? choices[0];
  const efforts = chosenModel?.thinkingOptions ?? [];
  const chosenEffort = efforts.find(entry => entry.id === effort) ?? efforts.find(entry => entry.id === chosenModel?.defaultThinkingOptionId) ?? efforts.find(entry => entry.isDefault);
  const modes = useQuery({ queryKey: ["mission-control", "launch-modes", binding.serverId, chosenProvider], queryFn: () => paseo.providers.listModes(chosenProvider!), enabled: status?.action === "start" && Boolean(chosenProvider), staleTime: 60_000, retry: false });
  const permissionModes = modes.data?.modes ?? [];
  const chosenMode = permissionModes.find(entry => entry.id === mode) ?? null;
  const button = { minHeight: 44, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 7, justifyContent: "center" as const, borderWidth: 1, borderColor: colors.border };
  const failure = error || (query.error instanceof Error ? query.error.message : null);
  const catalogFailure = providers.error || models.error || providers.data?.error || models.data?.error;
  const branch = status?.action === "start" && status.canIsolate && isolate ? status.branch : null;
  const branchOption = branch && branch.options.length > 1 ? branch.options.find(entry => entry.type === branchType) : branch?.options[0];
  const branchProblem = branch ? branch.problem ?? branchOption?.problem ?? (branchOption ? null : "The task's branch name is unknown. Refresh this task.") : null;

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
      {status.action === "start" ? <View style={{ gap: 9 }}>
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
        {providers.isPending || models.isFetching ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Loading available models…</Text> : null}
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
        {["start", "resume", "recover"].includes(status.action) ? <Pressable accessibilityRole="button" disabled={busy || query.isError || (status.action === "start" && (!chosenModel || Boolean(catalogFailure) || models.isFetching || Boolean(branchProblem)))} onPress={() => void launch()} style={{ ...button, backgroundColor: colors.accent, opacity: busy || query.isError || (status.action === "start" && (!chosenModel || Boolean(catalogFailure) || models.isFetching || Boolean(branchProblem))) ? 0.5 : 1 }}><Text style={{ color: colors.accentForeground, fontWeight: "600" }}>{busy ? "Starting…" : status.action === "start" ? "Start task" : status.action === "resume" ? "Resume task" : "Continue launch"}</Text></Pressable> : null}
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
