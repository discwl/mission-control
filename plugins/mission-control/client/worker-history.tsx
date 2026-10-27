import { useHosts, type PluginClientContext, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { listIncludingBackground, ownHost } from "../shared/background";
import { listOrchestratorWork } from "../shared/orchestrator-work";
import { getOrchestratorBindings } from "../shared/orchestrator";
import { CompactLink } from "./compact-link";
import { navigateWithCoordinatorReturn } from "./coordinator-return";
import { formatDateTime } from "./date-time";
import { HostRpcProvider, useMissionControlCopy, useRpc } from "./host-rpc";
import { PageScrollView, usePageState } from "./page-state";
import { readClientStorage, writeClientStorage } from "./web";
import { mergeWorkerHistory, restoreWorkerHistory, workerGroups, workerKey, workerOwnerKey, type WorkerGroup, type WorkerRecord } from "./worker-history-model";
import { readWorkerRoster } from "./worker-roster";

export const workerHistoryScreenId = "worker-history";
const storageKey = "mission-control:worker-history:v1";
function loadHistory(owner: string): WorkerRecord[] {
  try { const entries: unknown = JSON.parse(readClientStorage(storageKey) ?? "[]"); return Array.isArray(entries) ? entries.flatMap(entry => restoreWorkerHistory(entry, owner)).slice(0, 1000) : []; }
  catch { return []; }
}
function saveHistory(owner: string, workers: WorkerRecord[]) {
  try {
    const value: unknown = JSON.parse(readClientStorage(storageKey) ?? "[]");
    const others = Array.isArray(value) ? value.filter(entry => entry && entry.owner !== owner).slice(-19) : [];
    writeClientStorage(storageKey, JSON.stringify([...others, { version: 1, owner, workers }]));
  } catch { /* History remains live when device storage is disabled. */ }
}
export function WorkerHistoryScreen(props: PluginScreenProps) {
  const ownerServerId = props.params.serverId || props.host.id;
  const bridge = useMissionControlCopy(ownerServerId);
  if (ownerServerId === props.host.id) return <WorkerHistory key={`${ownerServerId}:${props.params.agentId}`} {...props} ownerServerId={ownerServerId} linksAvailable />;
  return "copy" in bridge ? <HostRpcProvider copy={bridge.copy}><WorkerHistory key={`${ownerServerId}:${props.params.agentId}`} {...props} ownerServerId={ownerServerId} linksAvailable /></HostRpcProvider>
    : <WorkerHistory key={`${ownerServerId}:${props.params.agentId}`} {...props} ownerServerId={ownerServerId} linksAvailable={ownerServerId === props.host.id} />;
}
function WorkerHistory({ theme, host, layout, navigation, params, ownerServerId, linksAvailable }: PluginScreenProps & { ownerServerId: string; linksAvailable: boolean }) {
  const colors = theme.colors;
  const owner = { serverId: ownerServerId, agentId: params.agentId ?? "" };
  const identity = workerOwnerKey(owner);
  const history = useRef<WorkerRecord[]>(loadHistory(identity));
  const known = useHosts();
  const hosts = [{ serverId: host.id, label: host.label, status: "online" }, ...known.filter(item => item.serverId !== host.id)];
  const readLinks = useRpc(listOrchestratorWork);
  const readBindings = useRpc(getOrchestratorBindings);
  const bindingQuery = useQuery({ queryKey: ["mission-control", "worker-history-binding", owner.serverId, params.workspaceId], queryFn: () => readBindings({ workspaceIds: [params.workspaceId] }), enabled: Boolean(params.workspaceId) && linksAvailable, staleTime: 30_000, retry: false });
  const binding = bindingQuery.data?.bindings[params.workspaceId];
  const bindingProblem = bindingQuery.data?.problems?.[params.workspaceId];
  const rosters = useQueries({ queries: hosts.map(remote => ({ queryKey: ["mission-control", "worker-history-roster", remote.serverId], queryFn: () => readWorkerRoster(remote.serverId), enabled: Boolean(owner.agentId) && remote.status === "online", refetchInterval: remote.status === "online" ? 30_000 : false as const, staleTime: 10_000, retry: false })) });
  const links = useQueries({ queries: hosts.map(remote => ({ queryKey: ["mission-control", "orchestrator-work", owner.serverId, owner.agentId, remote.serverId], queryFn: () => readLinks({ ...owner, remoteServerId: remote.serverId }), enabled: Boolean(owner.agentId) && linksAvailable && binding?.serverId === remote.serverId, refetchInterval: binding?.serverId === remote.serverId ? 30_000 : false as const, retry: false })) });
  const observations = hosts.flatMap((remote, index) => {
    const result = rosters[index]; const data = result.data;
    return data ? [{ serverId: remote.serverId, hostLabel: remote.label, ...data, links: binding?.serverId === remote.serverId ? links[index].data?.links ?? [] : [], linksKnown: bindingQuery.isSuccess && !bindingQuery.isError && !bindingProblem && (binding?.serverId !== remote.serverId || links[index].isSuccess && !links[index].isError), complete: !data.hasMore, current: remote.status === "online" && !result.isError, observedAt: data.observedAt }] : [];
  });
  const rows = mergeWorkerHistory(history.current, observations, owner);
  const serialized = JSON.stringify(rows.map(({ available: _available, ...row }) => row));
  useEffect(() => { history.current = JSON.parse(serialized); if (owner.agentId) saveHistory(identity, history.current); }, [identity, serialized]);
  const [group, setGroup] = usePageState<"All" | WorkerGroup>(`workers:${identity}:group`, "All");
  const [search, setSearch] = usePageState(`workers:${identity}:search`, "");
  const [hostFilter, setHostFilter] = usePageState(`workers:${identity}:host`, "all");
  const [showProblems, setShowProblems] = useState(false);
  const problems = hosts.flatMap((remote, index) => {
    const issue = remote.status !== "online" ? "offline; showing saved history" : rosters[index].isError ? "could not refresh; showing saved history" : rosters[index].data?.hasMore ? "partial host list; older workers may be missing" : binding?.serverId === remote.serverId && links[index].isError ? `saved worker links could not be refreshed: ${String(links[index].error)}` : null;
    return issue ? [`${remote.label}: ${issue}.`] : [];
  });
  const [error, setError] = useState<string | null>(null);
  const loading = bindingQuery.isFetching || rosters.some(query => query.isFetching) || links.some(query => query.isFetching);
  const visible = rows.filter(row => (group === "All" || row.group === group) && (hostFilter === "all" || row.serverId === hostFilter) && `${row.name} ${row.hostLabel} ${row.workspaceName}`.toLowerCase().includes(search.toLowerCase()));
  const go = (serverId: string, id: string, kind: "agent" | "workspace") => {
    try {
      if (!navigation) throw new Error("Navigation is unavailable in this client.");
      navigateWithCoordinatorReturn({ version: 1, kind: "chat", ...owner, workspaceId: params.workspaceId ?? "", label: params.label || "Coordinator chat" }, () => kind === "agent" ? navigation.openAgent({ serverId, agentId: id }) : navigation.openWorkspace({ serverId, workspaceId: id }));
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const message = (text: string, warning = false) => <Text style={{ color: warning ? colors.statusWarning : colors.foregroundMuted, fontSize: 12 }}>{text}</Text>;
  return <PageScrollView memoryKey={`worker-history:${identity}`} style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 14 : 24, gap: 14 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 24, fontWeight: "700", flex: 1 }}>This chat’s workers</Text>
      <CompactLink label="Return to chat" colors={colors} disabled={!navigation || !owner.agentId} onPress={() => { try { navigation?.openAgent({ serverId: owner.serverId, agentId: owner.agentId }); } catch (cause) { setError(String(cause)); } }} />
      <CompactLink label={loading ? "Refreshing…" : "Refresh"} colors={colors} disabled={loading} onPress={() => { for (const query of rosters) void query.refetch(); for (let index = 0; index < links.length; index++) if (linksAvailable && binding?.serverId === hosts[index].serverId) void links[index].refetch(); if (linksAvailable && params.workspaceId) void bindingQuery.refetch(); }} />
    </View>
    {message(`${params.label || "Selected chat"} · Native children and explicitly linked workers, including descendants. Opening a worker keeps it in this history.`)}
    {message("Newest activity first. Completed means a finished turn, not approved or delivered work. Idle and closed sessions stay under Idle unless Paseo reports a finished turn.")}
    {!owner.agentId ? message("Open Workers from a chat or use ‘This chat’s workers’ in the Command Center.", true) : null}
    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{error}</Text> : null}
    {!linksAvailable || bindingQuery.isError || bindingProblem ? message(`The coordinator’s worker-link configuration is unavailable. Native children remain visible; saved worker links cannot be refreshed.${bindingProblem ? ` ${bindingProblem}` : ""}`, true) : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>{(["All", ...workerGroups] as const).map(name => <CompactLink key={name} label={`${name} · ${name === "All" ? rows.length : rows.filter(row => row.group === name).length}`} selected={group === name} colors={colors} onPress={() => setGroup(name)} />)}</View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}><CompactLink label="All hosts" selected={hostFilter === "all"} colors={colors} onPress={() => setHostFilter("all")} />{[...new Map(rows.map(row => [row.serverId, row.hostLabel])).entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, label]) => <CompactLink key={id} label={label} colors={colors} selected={hostFilter === id} onPress={() => setHostFilter(id)} />)}</View>
    <TextInput accessibilityLabel="Find this chat’s workers" value={search} onChangeText={setSearch} placeholder="Find a worker, host, or workspace" placeholderTextColor={colors.foregroundMuted} style={{ color: colors.foreground, backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 7, padding: 12 }} />
    {problems.length ? <View style={{ gap: 5 }}><CompactLink label={`${problems.length} hosts offline or with limited data · ${showProblems ? "Hide details" : "Show details"}`} expanded={showProblems} colors={colors} onPress={() => setShowProblems(!showProblems)} />{showProblems ? problems.map(problem => <View key={problem}>{message(problem, true)}</View>) : null}</View> : null}
    {!visible.length ? message(loading ? "Reading worker history…" : rows.length ? "No workers match these filters." : "No children or linked workers have been found for this chat. Existing work can be linked from the orchestrator’s Review or Supervisor view.") : null}
    {visible.map(row => <View key={workerKey(row)} style={{ gap: 8, padding: 14, borderColor: row.group === "Needs you" ? colors.statusWarning : colors.border, borderWidth: 1, borderRadius: 8, backgroundColor: colors.surface1 }}>
      <Text style={{ color: colors.foreground, fontWeight: "700", fontSize: 15 }}>{row.name}</Text>
      <Text selectable style={{ color: colors.foregroundMuted }}>{row.hostLabel} › {row.workspaceName}</Text>
      {message(`${row.group} · ${row.status} · ${row.relationship} · Last activity: ${row.activityAt ? formatDateTime(row.activityAt) : "Unknown"}`)}
      {row.outcome ? message(`Agent summary: ${row.outcome}`) : message("No outcome summary reported. Open the conversation for its result.")}
      {!row.available ? message(`Last seen ${formatDateTime(row.observedAt)}. This row is saved history; current availability or ownership could not be verified.`, true) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CompactLink label="Open agent" colors={colors} disabled={!row.available || !navigation} onPress={() => go(row.serverId, row.agentId, "agent")} />
        {row.workspaceId ? <CompactLink label="Open workspace" colors={colors} disabled={!row.available || !navigation} onPress={() => go(row.serverId, row.workspaceId!, "workspace")} /> : null}
      </View>
    </View>)}
    {message("History is stored on this device for up to 20 chats and 1,000 workers per chat. Live records come from your already connected hosts. No additional host registration is needed.")}
  </PageScrollView>;
}
export function registerWorkerHistory(client: PluginClientContext) {
  const removeScreen = client.addScreen({ id: workerHistoryScreenId, title: "This chat’s workers", Component: WorkerHistoryScreen });
  const open = (agent: { id: string; workspaceId?: string | null; title?: string | null }) => {
    if (!agent.workspaceId) throw new Error("This chat has no workspace.");
    const address = client.paseo.agents.ref(agent.id).address;
    client.openScreen({ screenId: workerHistoryScreenId, params: { serverId: address.serverId, agentId: agent.id, workspaceId: agent.workspaceId, label: agent.title || "Coordinator chat" } });
  };
  const removeCommand = client.addCommandCenterItem({ id: "chat-workers", title: "This chat’s workers", icon: "Network", keywords: ["history", "completed", "archived", "remote", "subagents"], context: "agent", onSelect: ({ agent }) => open(agent) });
  const pills = new Map<string, { workspaceId: string; remove(): void }>();
  let stopped = false; let reading = false;
  async function sync() {
    if (stopped || reading) return;
    reading = true;
    try {
      const result = await listIncludingBackground(ownHost, {}, filter => client.paseo.agents.list({ filter, page: { limit: 200 } }));
      if (stopped) return;
      const active = result.entries.map(item => item.agent).filter(agent => agent.workspaceId && !agent.archivedAt && agent.status !== "closed");
      const ids = new Set(active.map(agent => agent.id));
      for (const agent of active) {
        const old = pills.get(agent.id);
        if (old?.workspaceId === agent.workspaceId) continue;
        old?.remove();
        const registration = client.addComposerPill({ id: `worker-history-${agent.id}`, workspaceId: agent.workspaceId!, agentId: agent.id, button: { title: "This chat’s worker history across hosts", label: "Workers", icon: "Network", behavior: { kind: "action", onPress: () => open(agent) } } });
        pills.set(agent.id, { workspaceId: agent.workspaceId!, remove: () => registration.remove() });
      }
      if (!result.pageInfo.hasMore) for (const [id, pill] of pills) if (!ids.has(id)) { pill.remove(); pills.delete(id); }
    } catch { /* Retry without discarding existing registrations. */ }
    finally { reading = false; }
  }
  void sync(); const timer = setInterval(() => void sync(), 30_000);
  return () => { stopped = true; clearInterval(timer); for (const pill of pills.values()) pill.remove(); removeCommand(); removeScreen(); };
}
