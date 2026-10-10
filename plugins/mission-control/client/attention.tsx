import type { PluginHostSummary, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { formatDateTime } from "./date-time";
import { DeliveryResultCard } from "./delivery-results";
import { MergeButton, MergeDialog, useDeliveryResults, useMergeReady, type MergeTarget } from "./merge-action";
import { PullRequestButton, PullRequestDialog, PullRequests, type PullRequestTarget } from "./pull-request-action";
import { NeedsYou } from "./needs-you";
import { pageKey } from "./page-memory";
import { PageScrollView as ScrollView } from "./page-state";
import { PermissionCard } from "./permissions";
import { agentKey, mayReadChat, pendingPrompts, taskLine, waitingCards, type AttentionRoster, type Replied, type WaitingCard } from "./attention-model";
import { useWaiting, WaitingCardView } from "./attention-card";
import { CompactLink } from "./compact-link";
import { Breadcrumbs } from "./breadcrumbs";

export { pendingPrompts } from "./attention-model";

type Colors = PluginSurfaceProps["theme"]["colors"];
// Mission Control's roster satisfies AttentionRoster, the fields Attention reads.
type RosterState = { data?: AttentionRoster; isError: boolean };

export type AttentionActions = {
  openAgent: (serverId: string, agentId: string) => void;
  openDocs: (workspaceId: string, taskId: string) => void;
  openReview: (workspaceId: string) => void;
};

/** How many Waiting for you cards Attention shows, for the tab's count. */
export function useWaitingCount(serverId: string, online: boolean, hosts: readonly PluginHostSummary[], rosters: readonly RosterState[]) {
  const waiting = useWaiting(serverId, online);
  return waitingCards({ hosts, rosters, localServerId: serverId, questions: waiting.data?.questions, taskTitles: waiting.data?.taskTitles }).length;
}

function Heading({ title, count, colors, children }: { title: string; count?: number; colors: Colors; children?: ReactNode }) {
  return <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
    <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 15, fontWeight: "600", flex: 1 }}>{title}{count !== undefined ? ` (${count})` : ""}</Text>
    {children}
  </View>;
}

const Muted = ({ children, colors }: { children: ReactNode; colors: Colors }) => <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{children}</Text>;

/**
 * Mission Control's Attention tab: what needs an answer (permission prompts and agent errors on every
 * online host, this host's recorded questions, and its plan and review decisions), the approved tasks ready to deliver (Merge, or Open PR for
 * pull-request projects), the results of deliveries until dismissed, and the open pull requests.
 */
export function Attention({ colors, compact, serverId, hosts, rosters, memory, actions }: {
  colors: Colors; compact: boolean; serverId: string; hosts: readonly PluginHostSummary[]; rosters: readonly RosterState[]; memory: string; actions: AttentionActions;
}) {
  const queryClient = useQueryClient();
  // The dialogs live here, so they stay open after the delivered task leaves the Ready list.
  const [mergeTarget, setMergeTarget] = useState<MergeTarget | null>(null);
  const [pullRequestTarget, setPullRequestTarget] = useState<PullRequestTarget | null>(null);
  const installation = hosts.find(candidate => candidate.serverId === serverId);
  const online = installation?.status === "online";
  const hostLabel = installation?.label ?? "this host";
  const ready = useMergeReady(serverId, online);
  const results = useDeliveryResults(serverId, online);
  const prompts = pendingPrompts(hosts, rosters);
  const unread = hosts.filter((host, index) => host.status === "online" && rosters[index]?.isError).map(host => host.label);
  const localRoster = rosters[hosts.findIndex(candidate => candidate.serverId === serverId)]?.data;
  const placeOf = (roster: AttentionRoster | undefined, workspaceId: string | null) => roster?.workspaces.find(workspace => workspace.id === workspaceId);
  const cards = results.data?.results ?? [];
  const delivering = new Set(cards.filter(entry => entry.state === "running").map(entry => entry.taskId));
  const readyTasks = (ready.data?.tasks ?? []).filter(task => !delivering.has(task.taskId));
  const waitingQuery = useWaiting(serverId, online);
  const taskTitles = waitingQuery.data?.taskTitles;
  // Replies sent from here, so their cards hide at once rather than at the next roster refresh.
  const [replied, setReplied] = useState<Replied>({});
  const waiting = waitingCards({ hosts, rosters, localServerId: serverId, questions: waitingQuery.data?.questions, taskTitles, replied });
  const markReplied = (card: WaitingCard) => setReplied(current => ({ ...current, [agentKey(card.serverId, card.agentId)]: new Date().toISOString() }));

  return <ScrollView memoryKey={pageKey(memory, "scroll")} scrollEnabled={!compact} style={{ flex: compact ? undefined : 1, minHeight: 0 }} contentContainerStyle={{ gap: 16, paddingBottom: 6 }} nestedScrollEnabled>
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, flex: 1, minWidth: 200 }}>Permission prompts and agent errors from every online host; questions, decisions, tasks to deliver and pull requests from {hostLabel}.</Text>
      <CompactLink label="Refresh" colors={colors} onPress={() => { void queryClient.invalidateQueries({ queryKey: ["mission-control"] }); }} />
    </View>

    <View style={{ gap: 8 }}>
      <Heading title="Needs you" colors={colors} />
      {unread.length ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Couldn't read the agents on {unread.join(", ")}, so their prompts aren't shown.</Text> : null}
      {prompts.map(({ host, roster, agent, request }) => {
        const task = taskLine({ taskId: agent.taskId, agentName: agent.name, taskTitles: host.serverId === serverId ? taskTitles : undefined, hostLabel: host.label, workspace: placeOf(roster, agent.workspaceId) });
        return <PermissionCard key={`${host.serverId}:${request.id}`} serverId={host.serverId} agentId={agent.id} agentName={agent.name} request={request} colors={colors} brief
          task={task} readChat={mayReadChat(agent)} openAgent={() => actions.openAgent(host.serverId, agent.id)} />;
      })}
      {waitingQuery.isError ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Couldn't read the agents' questions on {hostLabel}: {waitingQuery.error instanceof Error ? waitingQuery.error.message : String(waitingQuery.error)}</Text> : null}
      {waiting.map(card => <WaitingCardView key={card.key} card={card} colors={colors} openAgent={actions.openAgent} onReplied={markReplied} />)}
      <NeedsYou serverId={serverId} hostLabel={hostLabel} online={online} colors={colors} showHeading={false} brief actions={{
        describe: workspaceId => { const workspace = placeOf(localRoster, workspaceId); return workspace ? { hostLabel, projectName: workspace.projectName, workspaceName: workspace.name } : null; },
        openAgent: agentId => actions.openAgent(serverId, agentId),
        agentOf: agentId => localRoster?.agents.find(agent => agent.id === agentId) ?? null,
        openDocs: actions.openDocs,
      }} />
    </View>

    {cards.length ? <View style={{ gap: 8 }}>
      <Heading title="Results" count={cards.length} colors={colors} />
      {cards.map(entry => <DeliveryResultCard key={entry.resultId} entry={entry} serverId={serverId} online={online} colors={colors} />)}
    </View> : null}

    <View style={{ gap: 8 }}>
      <Heading title="Ready to deliver" count={ready.data ? readyTasks.length : undefined} colors={colors} />
      {ready.data?.warning ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning, fontSize: 12 }}>{ready.data.warning}</Text> : null}
      {!online ? <Muted colors={colors}>{hostLabel} is offline; its tasks are unavailable.</Muted>
        : ready.isPending ? <Muted colors={colors}>Loading approved tasks…</Muted>
          : ready.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>Approved tasks unavailable: {ready.error instanceof Error ? ready.error.message : String(ready.error)}</Text> : null}
      {ready.data && readyTasks.length === 0 ? <Muted colors={colors}>No approved tasks are waiting to be delivered on {hostLabel}.</Muted> : null}
      {readyTasks.map(task => {
        const workspace = placeOf(localRoster, task.workspaceId);
        return <View key={task.taskId} style={{ backgroundColor: colors.surface0, borderColor: colors.border, borderWidth: 1, borderLeftWidth: 3, borderLeftColor: colors.statusSuccess, borderRadius: 7, padding: 9, gap: 5 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>{task.title}</Text>
            <CompactLink label="Review changes" colors={colors} accessibilityLabel={`Review changes of ${task.title}`} onPress={() => actions.openReview(task.workspaceId)} />
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Review approved{task.approvedAt ? ` ${formatDateTime(task.approvedAt)}` : ""}</Text>
            {workspace ? <Breadcrumbs colors={colors} segments={[workspace.projectName, workspace.name]} /> : null}
          </View>
          {task.delivery === "pull-request"
            ? <PullRequestButton serverId={serverId} taskId={task.taskId} taskTitle={task.title} online={online} colors={colors} onOpen={setPullRequestTarget} />
            : <MergeButton serverId={serverId} taskId={task.taskId} taskTitle={task.title} online={online} colors={colors} onOpen={setMergeTarget} />}
        </View>;
      })}
    </View>
    <PullRequests serverId={serverId} hostLabel={hostLabel} online={online} colors={colors} heading={count => <Heading title="Pull requests" count={count} colors={colors} />} />
    <MergeDialog serverId={serverId} online={online} colors={colors} target={mergeTarget} onClose={() => setMergeTarget(null)} />
    <PullRequestDialog serverId={serverId} online={online} colors={colors} target={pullRequestTarget} onClose={() => setPullRequestTarget(null)} />
  </ScrollView>;
}
