import { CompactLink } from "./compact-link";
import { getPaseoClient, useHosts, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { AppModal as Modal } from "./app-modal";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  AGENT_STATE_LABELS, AGENT_STATES, agentAgeTimestamp, archiveOutcome, buildAgentTree, canDetach, collapseTree, confirmCopy, formatAge, isWorking, nodeKey,
  permissionCopy, subAgentsOf, summarizeTree, waitingByAgent, whereItsAt,
  type AgentState, type AgentTreeNode, type ConfirmAction, type FinishedHelpersNode, type HelperTreeNode, type TreeNode, type TreeSummary,
} from "../shared/agent-tree";
import { listAgentRuns, type AgentRun } from "../shared/agents-panel";
import { useWaiting } from "./attention-card";
import { waitingCards } from "./attention-model";
import { formatDateTime } from "./date-time";
import { LIVE_BACKSTOP_MS } from "./live-roster";
import { useDecisions } from "./needs-you";
import { PermissionCard } from "./permissions";
import { ProviderIcon } from "./provider-icons";
import { findAgent, rosterKey, rosterQuery, useLiveRoster, type Agent, type Roster } from "./roster";
import { mayQueryAgent } from "../shared/subagents";
import { InfoTip } from "./info-tip";
import { RenameAgents } from "./review-names";
import { AgentCleanupDialog } from "./agent-cleanup";
import { HelperMessages, PurposeLine, SubagentContextLink, useHelpers, useTaskTitles } from "./subagents";

type Colors = PluginSurfaceProps["theme"]["colors"];
type Node = AgentTreeNode<Agent>;
type Dialog = { action: ConfirmAction | "permission"; node: Node };

const CLOCK_MS = 15_000;
const INDENT = 14;
const MAX_INDENT_LEVELS = 6;

export function stateColor(state: AgentState, colors: Colors): string {
  if (state === "failed") return colors.statusDanger;
  if (state === "needs-input") return colors.statusWarning;
  if (state === "ready") return colors.statusSuccess;
  if (state === "working") return colors.accent;
  return colors.foregroundMuted;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Everything the tree shows for one workspace: the host's roster (kept live from Paseo's directory
 * subscriptions, with a 30-second backstop), helpers, task titles, open decisions and each agent's
 * latest run. Tasks, decisions, runs and helpers come from this Mission Control's own host.
 */
function useAgentTreeData(serverId: string, localServerId: string, workspaceId: string, online: boolean) {
  useLiveRoster(serverId, online);
  const roster = useQuery({ ...rosterQuery(serverId, online), refetchInterval: online ? LIVE_BACKSTOP_MS : false });
  const local = Boolean(serverId) && serverId === localServerId;
  // Parents past the page limit are listed too; archived ones are left out by the tree.
  const agents = useMemo(() => roster.data ? [...roster.data.agents, ...roster.data.outsideParents] : [], [roster.data]);
  const workspaceNames = useMemo(() => new Map((roster.data?.workspaces ?? []).map(workspace => [workspace.id, workspace.name])), [roster.data]);
  // Helpers are asked for only for members mayQueryAgent allows; asking about a stopped agent restarts it.
  const members = useMemo(() => buildAgentTree(agents, workspaceId).flatMap(node => node.kind === "agent" && node.member ? [node.agent] : []), [agents, workspaceId]);
  const helpers = useHelpers(serverId, localServerId, members, online);
  const taskTitles = useTaskTitles(localServerId, localServerId);
  const decisions = useDecisions(localServerId, online && local);
  // Recorded questions (task 24) count under Needs input exactly when Attention shows their Waiting for
  // you card: open, from a live agent in this host's roster, and not answered since in the chat.
  const waitingQuery = useWaiting(localServerId, online && local);
  const questions = local
    ? waitingCards({ hosts: [{ serverId: localServerId, label: "", status: online ? "online" : "offline" }], rosters: [{ data: roster.data }], localServerId, questions: waitingQuery.data?.questions })
      .filter(card => card.kind === "question").map(card => ({ agentId: card.agentId }))
    : [];
  const waiting = local ? waitingByAgent((decisions.data?.open ?? []).map(entry => ({ agentId: entry.decision.agentId })), questions) : new Map<string, number>();
  const readRuns = useRpc(listAgentRuns);
  const runs = useQuery({
    queryKey: ["mission-control", "agent-runs", localServerId],
    queryFn: () => readRuns({ serverId: localServerId }),
    enabled: online && local, staleTime: 15_000, refetchInterval: online && local ? LIVE_BACKSTOP_MS : false, retry: false,
  });
  return { roster, agents, workspaceNames, helpers, taskTitles, waiting, runs: (local && runs.data?.runs) || {}, local };
}

/**
 * The agent's latest assistant message, only for rows that need it and only as mayQueryAgent allows. It
 * is read again when the agent's state or last prompt changes, not on every update while it works.
 */
function useLatestMessage(serverId: string, agent: Agent, enabled: boolean) {
  const agentId = agent.id;
  return useQuery({
    queryKey: ["mission-control", "latest-message", serverId, agentId, agent.status, agent.attentionTimestamp ?? "", agent.lastUserMessageAt ?? ""],
    queryFn: async () => {
      const page = await getPaseoClient(serverId).agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 20, projection: "projected" });
      for (let index = page.entries.length - 1; index >= 0; index--) {
        const { item } = page.entries[index];
        if (item.type === "assistant_message" && item.text.trim()) return item.text;
      }
      return null;
    },
    enabled, staleTime: Infinity, gcTime: 10 * 60_000, retry: false,
  });
}

function Dot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, flexShrink: 0 }} />;
}

function IconButton({ label, icon, color, onPress, disabled }: { label: string; icon: string; color: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} hitSlop={4}
    style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 7, opacity: disabled ? 0.4 : 1 }}>
    <Icon name={icon} size={15} color={color} />
  </Pressable>;
}

function Rail({ depth, colors }: { depth: number; colors: Colors }) {
  if (!depth) return null;
  return <View style={{ flexDirection: "row", alignSelf: "stretch", marginLeft: (Math.min(depth, MAX_INDENT_LEVELS) - 1) * INDENT }}>
    <View style={{ width: INDENT, borderLeftWidth: 2, borderLeftColor: colors.border }} />
  </View>;
}

type RowContext = {
  serverId: string; workspaceId: string; local: boolean; online: boolean; now: number; colors: Colors;
  roster: Roster | undefined; workspaceNames: ReadonlyMap<string, string>; taskTitles: Record<string, string>; runs: Record<string, AgentRun>;
  canNavigate: boolean; openAgent: (agentId: string) => void; collapsed: ReadonlySet<string>; toggle: (agentId: string) => void;
  act: (dialog: Dialog) => void; busy: boolean; rename?: (agent: Agent) => ReactNode; cleanup?: (agent: Agent) => void;
};

function AgentMetadata({ agent, workspaceId, workspaceNames, colors }: {
  agent: Pick<Agent, "provider" | "model" | "reasoningLevel" | "workspaceId">; workspaceId: string; workspaceNames: ReadonlyMap<string, string>; colors: Colors;
}) {
  const workspaceName = agent.workspaceId ? workspaceNames.get(agent.workspaceId) : undefined;
  const elsewhere = Boolean(agent.workspaceId && agent.workspaceId !== workspaceId);
  const place = elsewhere ? workspaceName ? `Elsewhere: ${workspaceName}` : "Elsewhere" : agent.workspaceId ? null : "No workspace";
  return <View style={{ gap: 3 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <ProviderIcon provider={agent.provider} color={colors.foregroundMuted} size={13} />
      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11, flexShrink: 1 }}>{agent.model ? `${agent.provider}/${agent.model}` : agent.provider}</Text>
      {agent.reasoningLevel ? <Text accessibilityLabel={`Reasoning level: ${agent.reasoningLevel}`} style={{ color: colors.foregroundMuted, fontSize: 11, flexShrink: 0 }}>· {agent.reasoningLevel}</Text> : null}
    </View>
    {place ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>{place}</Text> : null}
  </View>;
}

function AgentStateLabel({ state, colors, online, contextOnly = false }: { state: AgentState; colors: Colors; online: boolean; contextOnly?: boolean }) {
  const label = contextOnly ? "Context" : AGENT_STATE_LABELS[state];
  const color = contextOnly ? colors.foregroundMuted : stateColor(state, colors);
  const working = !contextOnly && state === "working" && online;
  return <View accessible accessibilityLabel={label} accessibilityState={{ busy: working }} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
    {working ? <ActivityIndicator accessible={false} size={12} color={color} /> : !contextOnly && state === "ready" ? <Icon name="Check" size={13} color={color} /> : null}
    <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{label}</Text>
  </View>;
}

function AgentRow({ node, context }: { node: Node; context: RowContext }) {
  const { agent } = node;
  const { colors } = context;
  const run = context.runs[agent.id] ?? null;
  // The latest message is read only when nothing better says where the agent is at, and a stopped
  // agent's only when the user asks: reading its chat would start it.
  const [askedMessage, setAskedMessage] = useState(false);
  const wantsMessage = context.online && node.member && !agent.summary && !run;
  const latest = useLatestMessage(context.serverId, agent, wantsMessage && mayQueryAgent(agent, askedMessage));
  const offerMessage = wantsMessage && !mayQueryAgent(agent, askedMessage);
  const where = whereItsAt({ summary: agent.summary, run, message: latest.data });
  const color = stateColor(node.state, colors);

  // The task's title starts with its number, such as "26 · Agents panel"; an unknown task shows its ID's start.
  const task = agent.taskId ? context.taskTitles[agent.taskId] ?? agent.taskId.replace(/^task_/, "").slice(0, 8) : null;
  const expandable = node.descendants > 0 || node.helpers > 0;
  const collapsed = context.collapsed.has(agent.id);
  const counts = [
    node.descendants ? plural(node.descendants, "sub-agent", "sub-agents") : null,
    node.helpers ? `${plural(node.helpers, "helper", "helpers")}${node.runningHelpers ? `, ${node.runningHelpers} running` : ""}` : null,
  ].filter(Boolean).join(" · ");
  const age = formatAge(agentAgeTimestamp(agent), context.now);
  const waitingLabel = [
    agent.permissions.length ? plural(agent.permissions.length, "permission request", "permission requests") : null,
    node.waiting ? `${plural(node.waiting, "decision", "decisions")} waiting` : null,
  ].filter(Boolean).join(" · ");
  const canReply = agent.status !== "closed" && !isWorking(agent);
  const muted = colors.foregroundMuted;
  return <View style={{ flexDirection: "row", gap: 6, paddingVertical: 8, paddingRight: 8, paddingLeft: 6, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: node.depth === 0 ? colors.surface1 : "transparent", opacity: node.contextOnly ? 0.58 : 1 }}>
    <Rail depth={node.depth} colors={colors} />
    {expandable
      ? <IconButton label={`${collapsed ? "Expand" : "Collapse"} ${agent.name}`} icon={collapsed ? "ChevronRight" : "ChevronDown"} color={muted} onPress={() => context.toggle(agent.id)} />
      : <View style={{ width: 32 }} />}
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${agent.name}`} accessibilityHint={node.member ? undefined : "An agent in another workspace, shown because it started one here."}
        disabled={!context.canNavigate} onPress={() => context.openAgent(agent.id)} style={{ gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Dot color={color} />
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>{agent.name}</Text>
          {!node.member ? <Text style={{ color: muted, fontSize: 10, fontWeight: "700" }}>CONTEXT</Text> : null}
          {counts ? <Text numberOfLines={1} style={{ color: muted, fontSize: 11, flexShrink: 0 }}>{counts}</Text> : null}
        </View>
        <AgentMetadata agent={agent} workspaceId={context.workspaceId} workspaceNames={context.workspaceNames} colors={colors} />
        {task || agent.role ? <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 11 }}>{task ? `Task ${task}` : ""}{task && agent.role ? " · " : ""}{agent.role ? `Role: ${agent.role}` : ""}</Text> : null}
        {where ? <Text numberOfLines={1} style={{ color: muted, fontSize: 11, fontStyle: "italic" }}>{where}</Text> : null}
        {agent.lastError ? <Text numberOfLines={1} style={{ color: colors.statusDanger, fontSize: 11 }}>{agent.lastError}</Text> : null}
      </Pressable>
      {offerMessage ? <CompactLink colors={colors} label={"Read its latest message ▸"} accessibilityRole="button" accessibilityHint="Reading its chat starts this stopped agent in Paseo." onPress={() => setAskedMessage(true)} /> : null}
      {/* Task 25's purpose line: what a sub-agent started by another agent was started for. */}
      {node.member && agent.parentAgentId ? <PurposeLine serverId={context.serverId} agent={agent} taskTitles={context.taskTitles} colors={colors} prefix="Started for: " /> : null}
      {node.parentOutside && agent.parentAgentId && context.roster
        ? <SubagentContextLink parentAgentId={agent.parentAgentId} roster={context.roster} taskTitles={context.taskTitles} colors={colors} canNavigate={context.canNavigate} openAgent={context.openAgent} />
        : null}
      {node.member ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 2 }}>
        {agent.permissions.length ? <IconButton label={`Review ${plural(agent.permissions.length, "permission request", "permission requests")} from ${agent.name}`} icon="Lock" color={colors.statusWarning} disabled={context.busy} onPress={() => context.act({ action: "permission", node })} /> : null}
        {isWorking(agent) ? <IconButton label={`Interrupt and redirect ${agent.name}`} icon="CornerDownRight" color={colors.statusWarning} disabled={context.busy} onPress={() => context.act({ action: "redirect", node })} /> : null}
        {canReply ? <IconButton label={`Reply to ${agent.name}`} icon="MessageSquareMore" color={muted} disabled={context.busy} onPress={() => context.act({ action: "reply", node })} /> : null}
        {canDetach(agent) ? <IconButton label={`Detach ${agent.name} from its parent`} icon="Unlink" color={muted} disabled={context.busy} onPress={() => context.act({ action: "detach", node })} /> : null}
        {context.rename?.(agent)}
        {context.cleanup ? <IconButton label={`Check cleanup for ${agent.name}'s family`} icon="BrushCleaning" color={muted} disabled={context.busy || !context.online} onPress={() => context.cleanup?.(agent)} /> : null}
        <IconButton label={`Archive ${agent.name}`} icon="Archive" color={muted} disabled={context.busy} onPress={() => context.act({ action: "archive", node })} />
      </View> : null}
    </View>
    <View style={{ alignItems: "flex-end", gap: 3, maxWidth: 110 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, zIndex: 10 }}>
        <AgentStateLabel state={node.state} colors={colors} online={context.online} contextOnly={!node.member} />
        <InfoTip label={`Agent dates for ${agent.name}`} text={`Created ${formatDateTime(agent.createdAt)}\nLast prompt ${agent.lastUserMessageAt ? formatDateTime(agent.lastUserMessageAt) : "not recorded"}`} colors={colors} />
      </View>
      {waitingLabel ? <Text numberOfLines={2} style={{ color: colors.statusWarning, fontSize: 10, textAlign: "right" }}>{waitingLabel}</Text> : null}
      {age ? <Text accessibilityLabel={`Last activity ${formatDateTime(new Date(agentAgeTimestamp(agent)).toISOString())}`} style={{ color: muted, fontSize: 10 }}>{age}</Text> : null}
    </View>
  </View>;
}

function HelperRow({ node, context }: { node: HelperTreeNode; context: RowContext }) {
  const { helper } = node;
  const { colors } = context;
  const color = stateColor(node.state, colors);
  const age = formatAge(Date.parse(helper.updatedAt) || 0, context.now);
  return <View style={{ flexDirection: "row", gap: 6, paddingVertical: 7, paddingRight: 8, paddingLeft: 6, borderBottomWidth: 1, borderBottomColor: colors.border }}>
    <Rail depth={node.depth} colors={colors} />
    <View style={{ width: 32, alignItems: "center", paddingTop: 2 }}><Icon name="Bot" size={14} color={colors.foregroundMuted} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <Dot color={color} />
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 }}>{helper.title ?? "Helper"}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 10, fontWeight: "700" }}>HELPER</Text>
      </View>
      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>{node.label}</Text>
      {helper.description ? <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: 11 }}>{helper.description}</Text> : null}
      {context.local ? <HelperMessages serverId={context.serverId} helper={helper} colors={colors} /> : null}
    </View>
    <View style={{ alignItems: "flex-end", gap: 3 }}>
      <AgentStateLabel state={node.state} colors={colors} online={context.online} />
      {age ? <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>{age}</Text> : null}
    </View>
  </View>;
}

function FinishedHelpersRow({ node, colors, onToggle }: { node: FinishedHelpersNode; colors: Colors; onToggle: () => void }) {
  return <View style={{ flexDirection: "row", gap: 6, paddingLeft: 6, borderBottomWidth: 1, borderBottomColor: colors.border }}>
    <Rail depth={node.depth} colors={colors} />
    <View style={{ width: 32 }} />
    <CompactLink colors={colors} label={[(plural(node.count, "finished helper", "finished helpers")),(node.open ? "▾" : "▸")].join("")} accessibilityRole="button" onPress={onToggle} expanded={node.open} />
  </View>;
}

function ActionDialog({ dialog, current, context, agents, onClose }: {
  dialog: Dialog | null; current: Agent | null; context: RowContext; agents: readonly Agent[]; onClose: () => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const toast = useToast();
  const queryClient = useQueryClient();
  const { colors } = context;
  useEffect(() => { setMessage(""); setError(null); }, [dialog]);
  if (!dialog) return null;
  const agent = current ?? dialog.node.agent;
  const node = dialog.node;
  const outcome = archiveOutcome(agents, agent.id);
  const parentName = agent.parentAgentId && context.roster ? findAgent(context.roster, agent.parentAgentId)?.name ?? null : null;

  if (dialog.action === "permission") {
    const request = agent.permissions[0];
    const copy = permissionCopy(agent.name, request ? request.title || request.name : "nothing any more");
    return <Modal colors={colors} title={copy.title} open onOpenChange={open => { if (!open) onClose(); }} icon={<Icon name="Lock" size={18} color={colors.foreground} />}>
      <Modal.Content>
        <View style={{ gap: 12 }}>
          {request ? <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{copy.body}</Text>
            : <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{agent.name} has no pending requests now; it was answered.</Text>}
          {agent.permissions.map(item => <PermissionCard key={item.id} serverId={context.serverId} agentId={agent.id} agentName={agent.name} request={item} colors={colors} compact />)}
          <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
            <Pressable accessibilityRole="button" onPress={onClose} style={{ minHeight: 40, paddingHorizontal: 14, justifyContent: "center" }}><Text style={{ color: colors.foreground }}>Close</Text></Pressable>
          </View>
        </View>
      </Modal.Content>
    </Modal>;
  }

  const action = dialog.action;
  const copy = confirmCopy(action, {
    name: agent.name, state: node.state, permissions: agent.permissions.length, parentName,
    subAgents: subAgentsOf(agents, agent.id).length, archivedWithIt: outcome.archived, detachedFromIt: outcome.detached, untouched: outcome.untouched, runningHelpers: node.runningHelpers,
  });
  const needsText = action === "reply" || action === "redirect";
  const ready = !busy && context.online && (!needsText || message.trim().length > 0);

  async function confirm() {
    if (!ready || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    const handle = getPaseoClient(context.serverId).agents.ref(agent.id);
    try {
      if (needsText) await handle.send(message.trim());
      else if (action === "detach") await handle.detach();
      else if (!(await handle.archive())?.archivedAt) throw new Error("Paseo did not confirm that this agent was archived.");
      toast.show(action === "redirect" ? `${agent.name} redirected` : action === "reply" ? `Reply sent to ${agent.name}` : action === "detach" ? `${agent.name} detached` : `${agent.name} archived`, { variant: "success" });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      void queryClient.invalidateQueries({ queryKey: rosterKey(context.serverId) });
      lock.current = false;
      setBusy(false);
    }
  }

  const danger = action === "archive" || action === "redirect";
  return <Modal colors={colors} title={copy.title} open onOpenChange={open => { if (!open && !lock.current) onClose(); }}
    icon={<Icon name={action === "archive" ? "Archive" : action === "detach" ? "Unlink" : action === "redirect" ? "CornerDownRight" : "MessageSquareMore"} size={18} color={danger ? colors.statusDanger : colors.foreground} />}>
    <Modal.Content>
      <View style={{ gap: 12 }}>
        <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{copy.body}</Text>
        {needsText ? <TextInput accessibilityLabel={`Message to ${agent.name}`} autoFocus multiline value={message} onChangeText={setMessage} editable={!busy}
          placeholder="What should it do next?" placeholderTextColor={colors.foregroundMuted}
          style={{ minHeight: 96, color: colors.foreground, backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 10, textAlignVertical: "top" }} /> : null}
        {!context.online ? <Text style={{ color: colors.statusWarning }}>Reconnect this host to continue.</Text> : null}
        {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{error}</Text> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 10 }}>
          <Pressable accessibilityRole="button" disabled={busy} onPress={onClose} style={{ minHeight: 40, paddingHorizontal: 14, justifyContent: "center" }}><Text style={{ color: colors.foreground }}>Cancel</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={copy.confirm} disabled={!ready} onPress={() => void confirm()}
            style={{ minHeight: 40, paddingHorizontal: 14, justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: danger ? colors.statusDanger : colors.accent, backgroundColor: danger ? "transparent" : colors.accent, opacity: ready ? 1 : 0.5 }}>
            <Text style={{ color: danger ? colors.statusDanger : colors.accentForeground, fontWeight: "600" }}>{busy ? "Working…" : copy.confirm}</Text>
          </Pressable>
        </View>
      </View>
    </Modal.Content>
  </Modal>;
}

export type AgentTreeHeading = (summary: TreeSummary, controls: { refresh: () => void; refreshing: boolean; renameAll?: ReactNode }) => ReactNode;

/**
 * Every agent of a workspace as a tree, with sub-agents (and helpers inside their turns) under their
 * parents. The Agents panel, the Workspaces page and the Mission panel all use it, so sub-agents look
 * the same everywhere. brief leaves out search and wraps the status filters for the sidebar.
 */
export function AgentTree({ serverId, localServerId, workspaceId, online, colors, canNavigate, openAgent, heading, brief = false }: {
  serverId: string; localServerId: string; workspaceId: string; online: boolean; colors: Colors;
  canNavigate: boolean; openAgent: (agentId: string) => void; heading: AgentTreeHeading; brief?: boolean;
}) {
  const data = useAgentTreeData(serverId, localServerId, workspaceId, online);
  const namingHost = useHosts().find(host => host.serverId === serverId);
  const [filter, setFilter] = useState<AgentState | null>(null);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [openFinished, setOpenFinished] = useState<ReadonlySet<string>>(() => new Set());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [cleanupTarget, setCleanupTarget] = useState<{ agentId?: string } | null>(null);
  useEffect(() => { setCleanupTarget(null); }, [serverId, workspaceId]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const clock = setInterval(() => setNow(Date.now()), CLOCK_MS); return () => clearInterval(clock); }, []);

  const base = { workspaceNames: data.workspaceNames, taskTitles: data.taskTitles, waiting: data.waiting, helpers: data.helpers };
  const fullTree = buildAgentTree(data.agents, workspaceId, base);
  const summary = summarizeTree(fullTree, workspaceId, data.helpers);
  // Use unfiltered workspace members, excluding context parents from other workspaces.
  const namingAgents = fullTree.flatMap(node => node.kind === "agent" && node.member ? [node.agent] : []);
  const namingWorkspace = data.roster.data?.workspaces.find(workspace => workspace.id === workspaceId);
  const renameAgents = (agent?: Agent) => data.local && namingHost && namingWorkspace
    ? <RenameAgents key={`${serverId}:${workspaceId}:${agent?.id ?? "all"}`} host={namingHost} taskHostId={localServerId} workspace={namingWorkspace} agents={namingAgents}
        agentId={agent?.id} disabled={!online || dialog !== null || data.roster.isError} colors={colors} />
    : null;
  const nodes = collapseTree(buildAgentTree(data.agents, workspaceId, { ...base, openFinished, state: filter, query }), collapsed);
  const toggleIn = (set: ReadonlySet<string>, id: string) => { const next = new Set(set); if (!next.delete(id)) next.add(id); return next; };
  const context: RowContext = {
    serverId, workspaceId, local: data.local, online, now, colors, roster: data.roster.data, workspaceNames: data.workspaceNames,
    taskTitles: data.taskTitles, runs: data.runs, canNavigate, openAgent, collapsed, busy: dialog !== null,
    toggle: id => setCollapsed(current => toggleIn(current, id)),
    act: setDialog, rename: agent => renameAgents(agent),
    cleanup: data.local ? agent => setCleanupTarget({ agentId: agent.id }) : undefined,
  };
  const current = dialog ? data.agents.find(agent => agent.id === dialog.node.agent.id) ?? null : null;
  const muted = (text: string) => <Text style={{ color: colors.foregroundMuted, fontSize: 12, paddingVertical: 6 }}>{text}</Text>;
  const roster = data.roster;
  const chip = (state: AgentState | null, label: string) => {
    const selected = filter === state;
    return <Pressable key={state ?? "all"} accessibilityRole="button" accessibilityState={{ selected }} onPress={() => setFilter(state)}
      style={{ minHeight: 30, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 9, borderRadius: 15, borderWidth: 1, borderColor: selected ? colors.accent : colors.border, backgroundColor: selected ? colors.surface2 : colors.surface1 }}>
      {state ? <Dot color={stateColor(state, colors)} /> : null}
      <Text style={{ color: selected ? colors.foreground : colors.foregroundMuted, fontSize: 12, fontWeight: selected ? "600" : "400" }}>{label}</Text>
    </Pressable>;
  };

  const filters = <>
    {chip(null, `All ${summary.agents + summary.helpers}`)}
    {AGENT_STATES.map(state => chip(state, `${AGENT_STATE_LABELS[state]} ${summary.counts[state]}`))}
  </>;

  return <View style={{ gap: 8 }}>
    {heading(summary, { refresh: () => void roster.refetch(), refreshing: roster.isFetching, renameAll: <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>{renameAgents()}{data.local ? <CompactLink iconOnly label="Check cleanup for this workspace's agents" icon="BrushCleaning" colors={colors} disabled={!online || dialog !== null || roster.isError} onPress={() => setCleanupTarget({})} /> : null}</View> })}
    {!brief ? <TextInput accessibilityLabel="Search agents" autoCapitalize="none" autoCorrect={false} value={query} onChangeText={setQuery}
      placeholder="Search title, ID, model, task, workspace, label" placeholderTextColor={colors.foregroundMuted}
      style={{ height: 36, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, color: colors.foreground, backgroundColor: colors.surface1, fontSize: 13 }} /> : null}
    {brief ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{filters}</View>
      : <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>{filters}</ScrollView>}
    {!online ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>This host is offline. Showing the last agents seen.</Text> : null}
    {roster.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>Agents unavailable: {roster.error instanceof Error ? roster.error.message : String(roster.error)}</Text> : null}
    {roster.data?.hasMore ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>This host has more agents or workspaces than Mission Control reads at once, so some sub-agents may be missing.</Text> : null}
    {!data.local ? muted("Helpers inside agents' turns, tasks and decisions are shown only on the host running this Mission Control.") : null}
    <View style={{ borderTopWidth: nodes.length ? 1 : 0, borderTopColor: colors.border }}>
      {nodes.map(node => node.kind === "agent" ? <AgentRow key={nodeKey(node)} node={node} context={context} />
        : node.kind === "helper" ? <HelperRow key={nodeKey(node)} node={node} context={context} />
        : <FinishedHelpersRow key={nodeKey(node)} node={node} colors={colors} onToggle={() => setOpenFinished(current => toggleIn(current, node.parentId))} />)}
    </View>
    {roster.isPending && online ? muted("Reading this workspace's agents…") : null}
    {roster.data && !nodes.length ? muted(summary.agents ? brief ? "No agents match. Change the filter." : "No agents match. Change the filter or the search." : "No agents yet. Start an agent, or ask one to delegate; its sub-agents appear here.") : null}
    <ActionDialog dialog={dialog} current={current} context={context} agents={data.agents} onClose={() => setDialog(null)} />
    {cleanupTarget && data.local ? <AgentCleanupDialog key={`${serverId}:${workspaceId}:${cleanupTarget.agentId ?? "all"}`} scope={{ serverId, workspaceId, ...cleanupTarget }} colors={colors} online={online} onClose={() => setCleanupTarget(null)} /> : null}
  </View>;
}

/** "3 agents · 1 crew · 1 elsewhere · 2 helpers running" for a heading. */
export function treeSummaryLine(summary: TreeSummary): string {
  return [
    plural(summary.agents, "agent", "agents"),
    plural(summary.crews, "crew", "crews"),
    summary.elsewhere ? `${summary.elsewhere} elsewhere` : null,
    summary.runningHelpers ? `${plural(summary.runningHelpers, "helper", "helpers")} running` : null,
  ].filter(Boolean).join(" · ");
}
