import { useHosts, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text, View } from "react-native";
import type { NeedsYouTimeline } from "../shared/needs-you-timeline";
import { useWaiting, WaitingCardView } from "./attention-card";
import { waitingCards } from "./attention-model";
import { DecisionCard } from "./decision-card";
import { useDecisions } from "./needs-you";
import { useRoster } from "./roster";

/** The same request/actions as Attention, embedded in the linked agent's native chat. */
export function NeedsYouTimelineCard({ host, agentId, item, theme, layout }: PluginTimelineItemProps<NeedsYouTimeline>) {
  const ref = item.data;
  const correctHost = ref.serverId === host.id && ref.agentId === agentId;
  const hosts = useHosts();
  const online = correctHost && hosts.some(candidate => candidate.serverId === host.id && candidate.status === "online");
  const waiting = useWaiting(host.id, online && ref.kind === "question");
  const decisions = useDecisions(host.id, online && ref.kind === "decision");
  const roster = useRoster(host.id, online);
  const [replied, setReplied] = useState(false);
  const colors = theme.colors;
  const text = (value: string, error = false) => <Text accessibilityRole={error ? "alert" : undefined} style={{ color: error ? colors.statusDanger : colors.foregroundMuted, fontSize: 13 }}>{value}</Text>;
  if (!correctHost) return text("This request belongs to another agent or host.");
  if (!online) return text("Needs you · reconnect to this host to load the request.");
  const request = ref.kind === "question" ? waiting : decisions;
  if (request.isError || roster.isError) return text("Needs you could not be loaded. Reopen the chat or check Attention to retry.", true);
  if (!request.isSuccess || !roster.isSuccess) return text("Loading Needs you…");
  const agent = roster.data?.agents.find(candidate => candidate.id === agentId);
  if (!agent || agent.archivedAt || agent.status === "closed" || agent.workspaceId !== ref.workspaceId) return text("This request's agent is no longer active in this workspace.");
  const content = ref.kind === "question" ? (() => {
    const card = waitingCards({ hosts: [{ serverId: host.id, label: host.label, status: "online" }], rosters: [roster], localServerId: host.id, questions: waiting.data?.questions })
      .find(candidate => candidate.question?.question.questionId === ref.requestId && candidate.agentId === agentId);
    if (replied || !card) return text(agent.permissions.length ? "This agent is waiting on a native permission or question above." : "This question is no longer waiting for a reply.");
    return <WaitingCardView key={ref.requestId} card={card} colors={colors} openAgent={() => {}} onReplied={() => setReplied(true)} inChat />;
  })() : (() => {
    const entry = decisions.data?.open.find(candidate => candidate.decision.decisionId === ref.requestId && candidate.decision.serverId === host.id && candidate.decision.workspaceId === ref.workspaceId && candidate.decision.agentId === agentId);
    if (!entry) return text("This decision is no longer waiting for your response.");
    const workspace = roster.data?.workspaces.find(candidate => candidate.id === ref.workspaceId);
    return <DecisionCard key={`${ref.requestId}:${entry.revision}`} entry={entry} serverId={host.id} hostLabel={host.label} colors={colors} brief={layout.compact} inChat
      actions={{ describe: () => workspace ? { hostLabel: host.label, projectName: workspace.projectName, workspaceName: workspace.name } : null, openAgent: () => {}, agentOf: () => agent }} />;
  })();
  return <View style={{ gap: 8, paddingVertical: layout.compact ? 6 : 10 }}>{content}</View>;
}
