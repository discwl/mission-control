import { useHosts, useRpc, type PluginButtonIconProps, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { isOrchestratorDialogOpen, orchestratorDialogKey, setOrchestratorDialogOpen, subscribeOrchestratorDialogs } from "./orchestrator-dialog-request";
import { Text, TextInput, View } from "react-native";
import type { OrchestratorBinding } from "../shared/orchestrator";
import { listOrchestratorWork, setOrchestratorWork } from "../shared/orchestrator-work";
import { AppModal } from "./app-modal";
import { isolateModalEvents } from "./web";
import { Attention } from "./attention";
import { CompactLink } from "./compact-link";
import { formatDateTime } from "./date-time";
import { ReviewSections } from "./host-agents-panel";
import { hostReviewItems } from "./host-review-model";
import { HostRpcProvider, useMissionControlCopy } from "./host-rpc";
import { MissionDocs } from "./mission-docs";
import { MissionReview } from "./mission-review";
import { agentActivityAt, compareAgents, linkedWorkers, scopedReviews, type ReviewSort } from "./orchestrator-work-model";
import { rosterQuery, useLiveRoster, type Agent } from "./roster";

type Destination = (workspaceId: string, serverId: string, kind: "agent" | "workspace", id: string) => void;
// The pill icon is a mounted host contribution. Keeping the modal here avoids nesting a native
// modal inside a dismiss-on-outside-press popover, and leaves the current conversation selected.
export function createOrchestratorDialogIcon(binding: OrchestratorBinding, initial: "attention" | "review", openDestination: Destination) {
  return function DialogIcon(props: PluginButtonIconProps) {
    const agentId = props.context === "agent" ? props.agentId : "";
    const key = orchestratorDialogKey(props.workspaceId, agentId, binding.serverId, initial);
    const open = useSyncExternalStore(subscribeOrchestratorDialogs, () => isOrchestratorDialogOpen(key), () => false);
    // Paseo unmounts this icon while an action shows its pending spinner. Only closing the
    // dialog or removing its registration may clear the request; an icon unmount must not.
    return <>
      <Icon name={initial === "attention" ? "Bell" : "FileDiff"} size={props.size} color={props.color} />
      {open ? <OrchestratorDialog {...props} close={() => setOrchestratorDialogOpen(key, false)} binding={binding} initial={initial} openDestination={openDestination} /> : null}
    </>;
  };
}

function OrchestratorDialog(props: PluginButtonContentProps & { binding: OrchestratorBinding; initial: "attention" | "review"; openDestination: Destination }) {
  const { binding, initial, openDestination, theme, host, layout, workspaceId, close } = props;
  const agentId = props.context === "agent" ? props.agentId : "";
  const colors = theme.colors;
  const serverId = binding.serverId;
  const remote = useHosts().find(candidate => candidate.serverId === serverId);
  const online = remote?.status === "online";
  useLiveRoster(serverId, online);
  const query = useQuery(rosterQuery(serverId, online));
  const roster = query.data;
  const bridge = useMissionControlCopy(serverId);
  const copy = "copy" in bridge ? bridge.copy : null;
  const readLinks = useRpc(listOrchestratorWork);
  const setLink = useRpc(setOrchestratorWork);
  const cache = useQueryClient();
  const owner = { serverId: host.id, agentId, remoteServerId: serverId };
  const linkKey = ["mission-control", "orchestrator-work", host.id, agentId, serverId];
  const linksQuery = useQuery({ queryKey: linkKey, queryFn: () => readLinks(owner), enabled: Boolean(agentId), retry: false, refetchInterval: 10_000 });
  const links = linksQuery.data?.links ?? [];
  const agents = roster?.agents ?? [];
  const linked = linkedWorkers(agents, links);
  const direct = new Set(links.map(link => link.remoteAgentId));
  const [onlyLinked, setOnlyLinked] = useState(true);
  const [sort, setSort] = useState<ReviewSort>("activity");
  const [linking, setLinking] = useState(false);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"attention" | "review" | "docs">(initial);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [docsTaskId, setDocsTaskId] = useState<string | null>(null);
  const opened = roster?.workspaces.find(workspace => workspace.id === reviewId);
  const all = roster ? hostReviewItems(roster.workspaces, agents) : { ready: [], changed: [] };
  const review = {
    ready: scopedReviews(all.ready, agents, links, onlyLinked, sort),
    changed: scopedReviews(all.changed, agents, links, onlyLinked, sort),
  };
  const message = (text: string, warning = false) => <Text style={{ color: warning ? colors.statusWarning : colors.foregroundMuted, fontSize: 13 }}>{text}</Text>;
  const date = (at: string | null) => at ? formatDateTime(at) : "Unknown";
  const navigate = (kind: "agent" | "workspace", id: string) => {
    try { openDestination(workspaceId, serverId, kind, id); close(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const openReview = (id: string) => { setView("review"); setReviewId(id); };
  const selectScope = (linkedOnly: boolean) => {
    setOnlyLinked(linkedOnly);
    // The worker picker intentionally lists the whole host. Never leave it looking
    // like the scoped results after the user switches back to this chat.
    setLinking(false);
    setSearch("");
    setReviewId(null);
  };
  async function toggle(agent: Agent) {
    if (!agent.workspaceId || busy) return;
    setBusy(agent.id); setError(null);
    try {
      const result = await setLink({ ...owner, remoteAgentId: agent.id, remoteWorkspaceId: agent.workspaceId, taskId: agent.taskId, linked: !direct.has(agent.id) });
      cache.setQueryData(linkKey, result);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(null); }
  }
  const unavailable = message(!online ? `${binding.label} is ${remote?.status ?? "not connected"}. Connect it in Paseo.` : `Mission Control on ${binding.label} is unavailable or incompatible. Update it there to open this view.`, true);
  const title = view === "attention" ? `Waiting on you · ${binding.label}` : view === "docs" ? `Documents · ${binding.label}` : `Review on ${binding.label}`;
  return <View {...isolateModalEvents()}><AppModal colors={colors} title={title} open onOpenChange={next => { if (!next) close(); }} maxWidth={900}
    icon={<Icon name={view === "attention" ? "Bell" : "FileDiff"} size={18} color={colors.foreground} />}>
    <AppModal.Content>
      {!online ? unavailable : null}
      {query.isError ? message(`Could not refresh this host: ${String(query.error)}`, true) : null}
      {roster?.hasMore ? message("This host has additional workspaces or agents beyond the loaded list.", true) : null}
      {error ? message(error, true) : null}
      {view === "attention" ? copy && remote ? <HostRpcProvider copy={copy}>
        <Attention colors={colors} compact={layout.compact} serverId={serverId} hosts={[remote]} rosters={[{ data: roster, isError: query.isError }]}
          memory={`orchestrator-attention:${host.id}:${agentId}:${serverId}`} needsYouOnly actions={{
            openAgent: (_serverId, id) => navigate("agent", id),
            openDocs: (_workspaceId, taskId) => { setDocsTaskId(taskId); setView("docs"); }, openReview,
          }} />
      </HostRpcProvider> : unavailable : null}
      {view === "docs" ? <View style={{ height: layout.compact ? 420 : 560, gap: 8 }}>
        <CompactLink label="Back to Attention" colors={colors} onPress={() => setView("attention")} />
        {copy ? <HostRpcProvider copy={copy}><MissionDocs theme={theme} host={{ id: serverId, label: binding.label }} hostLabel={binding.label} layout={layout} initialTaskId={docsTaskId} /></HostRpcProvider> : unavailable}
      </View> : null}
      {view === "review" && reviewId ? <View style={{ height: layout.compact ? 420 : 560, gap: 8 }}>
        <CompactLink label="Back to review list" colors={colors} onPress={() => setReviewId(null)} />
        {copy && opened ? <HostRpcProvider copy={copy}><MissionReview key={`${serverId}:${opened.id}`} sessionId={`${host.id}:${agentId}`} serverId={serverId} localServerId={serverId} online={online} colors={colors} compact={layout.compact}
          workspace={{ id: opened.id, name: opened.name, projectName: opened.projectName, hostLabel: binding.label }} onChangeWorkspace={() => setReviewId(null)} onNavigate={close} /></HostRpcProvider> : unavailable}
      </View> : null}
      {view === "review" && !reviewId ? <View style={{ gap: 12 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <CompactLink label={onlyLinked ? "✓ This chat's work" : "This chat's work"} colors={colors} selected={onlyLinked} onPress={() => selectScope(true)} />
          <CompactLink label={!onlyLinked ? "✓ All host work" : "All host work"} colors={colors} selected={!onlyLinked} onPress={() => selectScope(false)} />
          <CompactLink label={linking ? "Hide worker links" : "Link workers"} colors={colors} onPress={() => setLinking(!linking)} />
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <CompactLink label={sort === "activity" ? "✓ Last activity" : "Last activity"} colors={colors} onPress={() => setSort("activity")} />
          <CompactLink label={sort === "updated" ? "✓ Agent updated" : "Agent updated"} colors={colors} onPress={() => setSort("updated")} />
          <CompactLink label="Refresh" colors={colors} disabled={query.isFetching || linksQuery.isFetching} onPress={() => { void query.refetch(); void linksQuery.refetch(); }} />
        </View>
        {message("Newest first in each group. Last activity uses the latest message, active turn start, or attention event reported by Paseo; Agent updated also includes metadata edits.")}
        {linksQuery.isError ? message(`Chat links could not be read: ${String(linksQuery.error)}`, true) : null}
        {linking ? <View style={{ gap: 8 }}>
          <Text accessibilityRole="header" style={{ color: colors.foreground, fontWeight: "600" }}>Choose workers from {binding.label}</Text>
          {message("This picker shows all workers on this host, including those not linked to this chat. Link the workers this chat manages. Their known subagents are included automatically. Linking changes this list only; it does not send work or assign authorship.")}
          <TextInput accessibilityLabel="Find worker" placeholder="Find worker or workspace" placeholderTextColor={colors.foregroundMuted} value={search} onChangeText={setSearch}
            style={{ color: colors.foreground, borderColor: colors.border, borderWidth: 1, borderRadius: 6, padding: 8 }} />
          {[...agents].filter(agent => agent.workspaceId && (!agent.archivedAt || direct.has(agent.id)) && `${agent.name} ${roster?.workspaces.find(workspace => workspace.id === agent.workspaceId)?.name ?? ""}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => compareAgents(a, b, sort)).map(agent => <View key={agent.id} style={{ gap: 4, padding: 8, borderColor: colors.border, borderWidth: 1, borderRadius: 6 }}>
            <Text style={{ color: colors.foreground, fontWeight: "600" }}>{agent.name}</Text>
            {message(`${roster?.workspaces.find(workspace => workspace.id === agent.workspaceId)?.name ?? agent.workspaceId} · ${agent.status} · Last activity: ${date(agentActivityAt(agent))}`)}
            <CompactLink label={busy === agent.id ? "Saving…" : direct.has(agent.id) ? "Unlink from this chat" : linked.has(agent.id) ? "Linked through parent" : "Link to this chat"} colors={colors}
              disabled={!online || Boolean(busy) || linksQuery.isPending || linksQuery.isError || (linked.has(agent.id) && !direct.has(agent.id))} onPress={() => void toggle(agent)} />
          </View>)}
        </View> : null}
        {!linksQuery.isPending && !linksQuery.isError && linked.size > 0 ? <View style={{ gap: 8 }}>
          <Text accessibilityRole="header" style={{ color: colors.foreground, fontWeight: "700" }}>Managed workers · {agents.filter(agent => linked.has(agent.id)).length}</Text>
          {message("Workers linked to this chat, including running workers without review-ready changes. Workspace changes may also include work from other agents.")}
          {agents.filter(agent => linked.has(agent.id)).sort((a, b) => compareAgents(a, b, sort)).map(agent => <View key={agent.id} style={{ gap: 4, padding: 8, borderColor: colors.border, borderWidth: 1, borderRadius: 6 }}>
            <Text style={{ color: colors.foreground, fontWeight: "600" }}>{agent.name}</Text>
            {message(`${roster?.workspaces.find(workspace => workspace.id === agent.workspaceId)?.name ?? agent.workspaceId ?? "Workspace unavailable"} · ${agent.status} · Last activity: ${date(agentActivityAt(agent))}`)}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <CompactLink label="Open agent" colors={colors} disabled={!online} onPress={() => navigate("agent", agent.id)} />
              {agent.workspaceId ? <CompactLink label="Review workspace" colors={colors} disabled={!online} onPress={() => openReview(agent.workspaceId!)} /> : null}
            </View>
          </View>)}
          {links.some(link => !agents.some(agent => agent.id === link.remoteAgentId)) ? message("Some linked workers are unavailable in the current host roster. Refresh the host before changing their links.", true) : null}
        </View> : null}
        {onlyLinked && linksQuery.isPending ? message("Loading this chat's workers…") : onlyLinked && linksQuery.isError ? null : <>
          {onlyLinked && !links.length ? message("No workers are linked to this chat yet. Use Link workers to select existing workers. All host work shows the rest of this host's workspaces.") : onlyLinked && roster && review.ready.length + review.changed.length === 0 ? message("This chat's linked workspaces have no review-ready changes yet. All host work shows other workspaces on this host.") : null}
          {!onlyLinked || (links.length > 0 && (!roster || review.ready.length + review.changed.length > 0)) ? <ReviewSections key={onlyLinked ? "chat" : "host"} hostLabel={binding.label} ready={review.ready} changed={review.changed} loaded={Boolean(roster)} colors={colors} linkedAgentIds={linked} canNavigate={online}
            openReview={openReview} openWorkspace={id => navigate("workspace", id)} openAgent={id => navigate("agent", id)} showDetails={id => { setSearch(roster?.workspaces.find(workspace => workspace.id === id)?.name ?? ""); setLinking(true); }} /> : null}
        </>}
      </View> : null}
    </AppModal.Content>
  </AppModal></View>;
}
