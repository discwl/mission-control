import { CompactLink } from "./compact-link";
import { getPaseoClient, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  childStatus, firstLine, helperQueryPlan, helpersByParent, listHelpers, listTaskTitles, mayQueryAgent, readablePurpose, readHelperMessages,
  subagentContextLine, subagentKindLabel, subagentSummary, type Helper, type QueryableAgent, type SubagentStatus,
} from "../shared/subagents";
import { formatDateTime } from "./date-time";
import { contextLineFor, subagentContextOf, useRoster, type Agent, type Roster } from "./roster";

type Colors = PluginSurfaceProps["theme"]["colors"];
type OpenAgent = (agentId: string) => void;

/**
 * Helpers inside these agents' turns. They come from this Mission Control's server, so they are
 * listed for its own host only; elsewhere, or when the call fails, the map is empty. A stopped agent
 * isn't asked (see mayQueryAgent), so it shows no helpers.
 */
export function useHelpers(serverId: string, localServerId: string, parents: readonly QueryableAgent[], online = true): Map<string, Helper[]> {
  const read = useRpc(listHelpers);
  const { enabled, ids } = helperQueryPlan(serverId, localServerId, parents, online);
  const query = useQuery({
    queryKey: ["mission-control", "helpers", serverId, ids.join(",")],
    queryFn: () => read({ serverId, parentAgentIds: ids }),
    enabled, staleTime: 10_000, refetchInterval: enabled ? 20_000 : false, retry: false,
  });
  return helpersByParent(enabled && !query.isError ? query.data : undefined);
}

/** Task titles on this Mission Control's host, for the context line; empty elsewhere. */
export function useTaskTitles(serverId: string, localServerId: string): Record<string, string> {
  const read = useRpc(listTaskTitles);
  const enabled = Boolean(serverId) && serverId === localServerId;
  const query = useQuery({
    queryKey: ["mission-control", "task-titles", serverId],
    queryFn: () => read({ serverId }),
    enabled, staleTime: 60_000, retry: false,
  });
  return (enabled && query.data?.titles) || {};
}

/**
 * Gives the context line of any agent on serverId's host that another agent started, from the shared
 * roster; null otherwise or while it loads. Task titles come from this Mission Control's own vault
 * (localServerId), which also names tasks for agents on other hosts.
 */
export function useContextLines(serverId: string, localServerId: string, online: boolean): (agent: { parentAgentId: string | null }) => string | null {
  const roster = useRoster(serverId, online);
  const taskTitles = useTaskTitles(localServerId, localServerId);
  return agent => roster.data ? contextLineFor(roster.data, agent, taskTitles) : null;
}

type ChatAgent = QueryableAgent;

/**
 * A separate agent's first prompt, as one line. It never changes, so it's read once. The chat is read
 * only as mayQueryAgent allows: a stopped agent's only when the user asks (asked).
 */
function useFirstPrompt(serverId: string, agent: ChatAgent, asked: boolean) {
  return useQuery({
    queryKey: ["mission-control", "first-prompt", serverId, agent.id],
    queryFn: async () => {
      const page = await getPaseoClient(serverId).agents.ref(agent.id).timeline.refetch({ direction: "after", limit: 20, projection: "projected" });
      const first = page.entries.find(({ item }) => item.type === "user_message");
      return first && first.item.type === "user_message" ? firstLine(first.item.text) : null;
    },
    enabled: Boolean(serverId) && mayQueryAgent(agent, asked), staleTime: Infinity, gcTime: 30 * 60_000, retry: false,
  });
}

/**
 * What a separate sub-agent was started for: its first prompt in one line, with task IDs shown as the
 * task's number and title. A stopped agent's chat is read only when the user asks.
 */
export function PurposeLine({ serverId, agent, taskTitles, colors, prefix = "" }: {
  serverId: string; agent: ChatAgent; taskTitles: Record<string, string>; colors: Colors; prefix?: string;
}) {
  const [asked, setAsked] = useState(false);
  const prompt = useFirstPrompt(serverId, agent, asked);
  if (!mayQueryAgent(agent, asked)) {
    return <CompactLink colors={colors} label={[(prefix),"Show what it was started for ▸"].join("")} accessibilityRole="button" accessibilityHint="Reading its chat starts this stopped agent in Paseo." onPress={() => setAsked(true)} />;
  }
  const text = prompt.data ? readablePurpose(prompt.data, taskTitles) : prompt.isPending ? "Reading its first prompt…" : "No first prompt found";
  return <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 12 }}>{prefix}{text}</Text>;
}

function statusColor(status: SubagentStatus, colors: Colors) {
  if (status === "running") return colors.statusSuccess;
  if (status === "error") return colors.statusDanger;
  return colors.foregroundMuted;
}

/** "↳ Sub-agent of <parent> · <task> · <project / workspace>", linking to the parent. */
export function SubagentContextLink({ parentAgentId, roster, taskTitles, colors, canNavigate, openAgent }: {
  parentAgentId: string; roster: Pick<Roster, "agents" | "outsideParents" | "workspaces">; taskTitles: Record<string, string>;
  colors: Colors; canNavigate: boolean; openAgent: OpenAgent;
}) {
  const context = subagentContextOf(roster, parentAgentId, taskTitles);
  const line = subagentContextLine(context);
  // A parent that is gone can't be opened, so its line is plain text.
  if (context.parentName === null) return <Text style={{ color: colors.foregroundMuted, fontSize: 12, paddingVertical: 4 }}>↳ {line}</Text>;
  return <CompactLink colors={colors} label={["↳ ",(line)].join("")} accessibilityRole="link" accessibilityLabel={`${line}. Open the parent agent.`} disabled={!canNavigate} onPress={() => openAgent(parentAgentId)} />;
}

function Entry({ name, purpose, kind, status, at, colors, children }: { name: string; purpose: ReactNode; kind: string; status: SubagentStatus; at: string; colors: Colors; children?: ReactNode }) {
  return <View style={{ borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: 8, gap: 2 }}>
    <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>{name}</Text>
    {typeof purpose === "string" ? <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 12 }}>{purpose}</Text> : purpose}
    <Text style={{ fontSize: 11, color: colors.foregroundMuted }}>{kind} · <Text style={{ color: statusColor(status, colors) }}>{status}</Text> · {formatDateTime(at)}</Text>
    {children}
  </View>;
}

/** "Last messages ▸": a helper's last few messages, read only while open. */
export function HelperMessages({ serverId, helper, colors }: { serverId: string; helper: Helper; colors: Colors }) {
  const [open, setOpen] = useState(false);
  const read = useRpc(readHelperMessages);
  const messages = useQuery({
    queryKey: ["mission-control", "helper-messages", serverId, helper.parentAgentId, helper.id],
    queryFn: () => read({ serverId, parentAgentId: helper.parentAgentId, helperId: helper.id }),
    enabled: open, staleTime: 10_000, refetchInterval: open && helper.status === "running" ? 20_000 : false, retry: false,
  });
  const shown = messages.data?.available ? messages.data.messages : null;
  return <>
    <CompactLink colors={colors} label={(open ? "Hide messages ▾" : "Last messages ▸")} accessibilityRole="button" onPress={() => setOpen(!open)} expanded={open} />
    {open ? <View style={{ gap: 4 }}>
      {messages.isPending ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Loading messages…</Text> : null}
      {!messages.isPending && !shown ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Messages aren't available for this helper.</Text> : null}
      {shown?.length === 0 ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>No messages yet.</Text> : null}
      {shown?.map((message, index) => <Text key={index} selectable numberOfLines={6} style={{ color: message.role === "user" ? colors.foregroundMuted : colors.foreground, fontSize: 11, lineHeight: 16 }}>
        {message.role === "user" ? "Asked: " : "Replied: "}{message.text}
      </Text>)}
    </View> : null}
  </>;
}

function HelperEntry({ serverId, helper, kind, colors }: { serverId: string; helper: Helper; kind: string; colors: Colors }) {
  return <Entry name={helper.title ?? "Helper"} purpose={helper.description ?? "No description"} kind={kind} status={helper.status} at={helper.updatedAt} colors={colors}>
    <HelperMessages serverId={serverId} helper={helper} colors={colors} />
  </Entry>;
}

function ChildEntry({ serverId, child, taskTitles, colors, canNavigate, openAgent }: { serverId: string; child: Agent; taskTitles: Record<string, string>; colors: Colors; canNavigate: boolean; openAgent: OpenAgent }) {
  return <Entry name={child.name} purpose={<PurposeLine serverId={serverId} agent={child} taskTitles={taskTitles} colors={colors} />} kind={subagentKindLabel("separate")} status={childStatus(child.status)} at={child.updatedAt} colors={colors}>
    <CompactLink colors={colors} label={"Open agent →"} accessibilityRole="button" accessibilityLabel={`Open agent ${child.name}`} disabled={!canNavigate} onPress={() => openAgent(child.id)} />
  </Entry>;
}

/**
 * "Sub-agents (N)" for an agent card or a task card: the parents' separate child agents from the
 * host's roster, and their helpers. Collapsed it says how many helpers run; finished helpers stay a count until asked for.
 */
export function SubagentsRow({ serverId, parents, agents, helpers, taskTitles = {}, colors, canNavigate, openAgent }: {
  serverId: string; parents: readonly Agent[]; agents: readonly Agent[]; helpers: Map<string, Helper[]>;
  // This Mission Control's task titles, so a purpose line names a task by number and title.
  taskTitles?: Record<string, string>;
  colors: Colors; canNavigate: boolean; openAgent: OpenAgent;
}) {
  const [open, setOpen] = useState(false);
  const [showFinished, setShowFinished] = useState(false);
  const parentIds = new Set(parents.map(parent => parent.id));
  const children = agents.filter(agent => agent.parentAgentId && parentIds.has(agent.parentAgentId) && !parentIds.has(agent.id));
  const helperList = parents.flatMap(parent => helpers.get(parent.id) ?? []);
  const running = helperList.filter(helper => helper.status === "running");
  const finished = helperList.filter(helper => helper.status !== "running");
  const total = children.length + helperList.length;
  if (!total) return null;
  const kind = (helper: Helper) => subagentKindLabel("helper", parents.length > 1 ? parents.find(parent => parent.id === helper.parentAgentId)?.name : null);
  const summary = subagentSummary({ children: children.length, running: running.length, finished: finished.length });
  return <View style={{ gap: 6 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Sub-agents (${total}): ${summary}`} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ minHeight: 36, justifyContent: "center" }}>
      <Text style={{ color: colors.foreground, fontSize: 12 }}>
        <Text style={{ fontWeight: "600" }}>Sub-agents ({total}) {open ? "▾" : "▸"}</Text>
        <Text style={{ color: running.length ? colors.statusSuccess : colors.foregroundMuted }}> · {summary}</Text>
      </Text>
    </Pressable>
    {open ? <View style={{ gap: 8 }}>
      {running.map(helper => <HelperEntry key={helper.id} serverId={serverId} helper={helper} kind={kind(helper)} colors={colors} />)}
      {children.map(child => <ChildEntry key={child.id} serverId={serverId} child={child} taskTitles={taskTitles} colors={colors} canNavigate={canNavigate} openAgent={openAgent} />)}
      {finished.length && !showFinished ? <CompactLink colors={colors} label={[(subagentSummary({ children: 0, running: 0, finished: finished.length }))," ▸"].join("")} accessibilityRole="button" onPress={() => setShowFinished(true)} /> : null}
      {showFinished ? finished.map(helper => <HelperEntry key={helper.id} serverId={serverId} helper={helper} kind={kind(helper)} colors={colors} />) : null}
    </View> : null}
  </View>;
}
