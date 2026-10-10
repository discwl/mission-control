import { Breadcrumbs } from "./breadcrumbs";
import { getPaseoClient, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { listWaiting, replyToQuestion, waitingKey } from "../shared/questions";
import { conversationSteps, errorCard, latestAgentQuote, questionCard, sendReply, timelineKey, timelineQueryOptions, waitingCardReadsChat, type CardModel, type TaskLine, type TimelineItem, type WaitingCard, type Where } from "./attention-model";
import { formatDateTime } from "./date-time";

type Colors = PluginSurfaceProps["theme"]["colors"];

/** This installation's open questions and task titles, for Attention's cards. */
export function useWaiting(serverId: string, enabled: boolean) {
  const read = useRpc(listWaiting);
  return useQuery({ queryKey: waitingKey(serverId), queryFn: () => read({ serverId }), enabled, staleTime: 10_000, refetchInterval: enabled ? 20_000 : false, retry: false });
}

/**
 * The tail of an agent's chat on its own host, read the way name suggestions read it. `version` changes
 * when the agent starts waiting on something new, so a new prompt reads the chat again. Otherwise it is
 * read only once, or when the user opens Conversation (see timelineQueryOptions).
 */
export function useTimeline(serverId: string, agentId: string | null, enabled: boolean, version = "") {
  return useQuery({
    queryKey: timelineKey(serverId, agentId, version),
    queryFn: async (): Promise<TimelineItem[]> => {
      const page = await getPaseoClient(serverId).agents.ref(agentId!).timeline.refetch({ direction: "tail", limit: 60, projection: "projected" });
      return page.entries.map(entry => entry.item as TimelineItem);
    },
    enabled: enabled && Boolean(agentId),
    ...timelineQueryOptions,
  });
}

export function Badge({ label, color, colors }: { label: string; color: string; colors: Colors }) {
  return <View style={{ borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3, backgroundColor: colors.surface2 }}>
    <Text style={{ color, fontSize: 11, fontWeight: "700" }}>{label}</Text>
  </View>;
}

/** The kind of request, then the task's number and title, then host / project / workspace. */
export function TaskHeader({ badge, badgeColor, task, colors, expanded = false }: { badge: string; badgeColor: string; task: TaskLine; colors: Colors; expanded?: boolean }) {
  return <View style={{ gap: 2 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Badge label={badge} color={badgeColor} colors={colors} />
      <Text numberOfLines={expanded ? undefined : 1} style={{ color: colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>{task.title}</Text>
    </View>
    {task.place ? <Breadcrumbs colors={colors} segments={task.place.split(" / ")} accessibilityLabel={task.place} /> : null}
  </View>;
}

/** Where it's at, in at most three lines: the agent's own summary, or a marked quote from its chat. */
export function WhereLine({ where, colors, full = false }: { where: Where | null; colors: Colors; full?: boolean }) {
  if (!where) return null;
  if (where.source === "chat") {
    return <Text numberOfLines={full ? undefined : 3} style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
      <Text style={{ fontWeight: "600" }}>Agent's latest message: </Text>“{where.text}”
    </Text>;
  }
  return <Text numberOfLines={full ? undefined : 3} style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{where.text}</Text>;
}

/** Needs from you, and the agent's recommendation when it gave one. Always shown. */
export function NeedLine({ need, recommendation, colors }: { need: string; recommendation: string | null; colors: Colors }) {
  return <View style={{ gap: 2 }}>
    <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}><Text style={{ fontWeight: "700" }}>Needs from you: </Text>{need}</Text>
    {recommendation ? <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}><Text style={{ fontWeight: "700" }}>Recommended: </Text>{recommendation}</Text> : null}
  </View>;
}

export function SmallLink({ label, onPress, colors, expanded, accessibilityLabel }: { label: string; onPress: () => void; colors: Colors; expanded?: boolean; accessibilityLabel?: string }) {
  return <CompactLink label={label} onPress={onPress} colors={colors} expanded={expanded} accessibilityLabel={accessibilityLabel} />;
}

const stepLabel = { you: "You", agent: "Agent", step: "Step", error: "Error" } as const;

/** The collapsed Conversation toggle and the small Open agent link at the foot of every Needs you card. */
export function CardFooter({ serverId, agentId, openAgent, colors, version, extra }: {
  serverId: string; agentId: string | null; openAgent?: (() => void) | null; colors: Colors; version?: string; extra?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const timeline = useTimeline(serverId, agentId, open, version);
  const steps = conversationSteps(timeline.data);
  // Opening reads the chat: the first time by enabling the query, after that by asking for it again.
  function toggle() {
    if (!open && timeline.data) void timeline.refetch();
    setOpen(!open);
  }
  if (!agentId) return null;
  return <View style={{ gap: 4 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 14 }}>
      <SmallLink label={open ? "Hide conversation" : "Conversation"} expanded={open} onPress={toggle} colors={colors} />
      {openAgent ? <SmallLink label="Open agent →" onPress={openAgent} colors={colors} /> : null}
    </View>
    {open ? <View style={{ gap: 4, borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: 8 }}>
      {extra ? <Text selectable style={{ color: colors.foreground, fontSize: 12 }}>{extra}</Text> : null}
      {timeline.isPending ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Reading the chat…</Text>
        : timeline.isError ? <Text style={{ color: colors.statusDanger, fontSize: 12 }}>Couldn't read the chat: {timeline.error instanceof Error ? timeline.error.message : String(timeline.error)}</Text>
          : steps.length ? steps.map((step, index) => <Text key={index} selectable style={{ color: step.kind === "error" ? colors.statusDanger : step.kind === "step" ? colors.foregroundMuted : colors.foreground, fontSize: 12, lineHeight: 17 }}>
            <Text style={{ fontWeight: "700" }}>{stepLabel[step.kind]}: </Text>{step.text}
          </Text>) : <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No messages yet.</Text>}
    </View> : null}
  </View>;
}

/** A Reply box that sends the text to the agent; the caller decides where it goes. */
function ReplyBox({ onSend, colors, placeholder, label }: { onSend: (text: string) => Promise<void>; colors: Colors; placeholder: string; label: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    setBusy(true);
    setError(null);
    try { await onSend(text); setText(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <View style={{ gap: 6 }}>
    <TextInput accessibilityLabel={label} placeholder={placeholder} placeholderTextColor={colors.foregroundMuted} value={text} onChangeText={setText} editable={!busy} multiline
      style={{ color: colors.foreground, backgroundColor: colors.surface0, borderColor: colors.border, borderWidth: 1, borderRadius: 7, padding: 8, minHeight: 44, fontSize: 13, textAlignVertical: "top" }} />
    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel={`Send: ${label}`} disabled={busy || !text.trim()} onPress={() => void send()}
      style={{ alignSelf: "flex-start", minHeight: 40, paddingHorizontal: 14, justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: colors.accent, backgroundColor: colors.accent, opacity: busy || !text.trim() ? 0.5 : 1 }}>
      <Text style={{ color: colors.accentForeground, fontSize: 12, fontWeight: "600" }}>{busy ? "Sending…" : "Send reply"}</Text>
    </Pressable>
  </View>;
}

/**
 * Waiting for you: a question the agent recorded, or an agent Paseo flagged with an error. Reply sends the
 * text to that agent on its host; `onReplied` hides the card until the roster shows the agent got it.
 */
export function WaitingCardView({ card, colors, openAgent, onReplied, inChat = false }: { card: WaitingCard; colors: Colors; openAgent: (serverId: string, agentId: string) => void; onReplied: (card: WaitingCard) => void; inChat?: boolean }) {
  const queryClient = useQueryClient();
  const reply = useRpc(replyToQuestion);
  const version = card.since ?? "";
  // Only a question without the agent's own summary, from a live agent, reads the chat before Conversation is
  // opened; an error card never does, since reading an errored agent's chat wakes it.
  const timeline = useTimeline(card.serverId, card.agentId, waitingCardReadsChat(card), version);
  const latest = latestAgentQuote(timeline.data);
  const model: CardModel = card.kind === "question" && card.question ? questionCard(card.question, card.task, latest) : errorCard(card.agent!, card.task);
  const tone = card.kind === "error" ? colors.statusDanger : colors.statusWarning;
  async function send(text: string) {
    try {
      await sendReply(card, text, {
        replyToQuestion: input => reply(input),
        sendToAgent: (serverId, agentId, message) => getPaseoClient(serverId).agents.ref(agentId).send(message),
      });
      onReplied(card);
    } finally { void queryClient.invalidateQueries({ queryKey: ["mission-control"] }); }
  }
  return <View accessibilityLabel={`${card.kind === "error" ? "Error" : "Question"} from ${model.task.title}`} style={{ borderColor: tone, borderWidth: 1, borderLeftWidth: 3, borderRadius: 8, padding: 9, gap: 5, backgroundColor: colors.surface1 }}>
    <TaskHeader badge={model.badge} badgeColor={tone} task={model.task} colors={colors} />
    <WhereLine where={model.where} colors={colors} />
    <NeedLine need={model.need} recommendation={model.recommendation} colors={colors} />
    {card.question?.question.delivery
      ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning, fontSize: 13 }}>A reply was attempted, but delivery could not be confirmed. Check the agent chat before replying there.</Text>
      : <ReplyBox onSend={send} colors={colors} label={`Reply to ${model.task.title}`} placeholder={card.kind === "error" ? "Tell the agent how to carry on" : "Your answer"} />}
    {inChat ? null : <CardFooter serverId={card.serverId} agentId={card.agentId} version={version} colors={colors} openAgent={() => openAgent(card.serverId, card.agentId)}
      extra={card.question ? `Asked ${formatDateTime(card.question.question.askedAt)}: ${card.question.question.question}` : card.agent?.lastError ? `Error: ${card.agent.lastError}` : null} />}
  </View>;
}
import { CompactLink } from "./compact-link";
