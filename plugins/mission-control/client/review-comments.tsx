import { getPaseoClient } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  listReviewComments,
  reviewCommentsKey,
  saveReviewComment,
  sendReviewComments,
  updateReviewComment,
  type CommentAnchor,
  type ReviewComment,
} from "../shared/review";
import { formatDateTime } from "./date-time";
import { Chip, LinkButton, mono, plural, type Colors } from "./review-ui";
import { flattenAgentTree, groupAgents, parentAgentIdOf } from "../shared/subagents";

export type ReviewAgent = { id: string; name: string; status: string; updatedAt: string; parentAgentId: string | null };
type Action = "delete" | "resolve" | "reopen" | "confirm-sent" | "confirm-not-sent";

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }

/** Agents in this workspace that can receive review comments. */
export function useWorkspaceAgents(serverId: string, workspaceId: string, online: boolean) {
  return useQuery({
    queryKey: ["mission-control", "review-agents", serverId, workspaceId],
    queryFn: async (): Promise<ReviewAgent[]> => {
      const { entries } = await getPaseoClient(serverId).agents.list({ page: { limit: 200 } });
      return entries.map(entry => entry.agent)
        .filter(agent => agent.workspaceId === workspaceId && !("archivedAt" in agent && agent.archivedAt) && agent.status !== "closed")
        .map(agent => ({ id: agent.id, name: agent.title || `${agent.provider} agent`, status: agent.status, updatedAt: agent.updatedAt, parentAgentId: parentAgentIdOf(agent) }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    enabled: online, staleTime: 5_000, refetchInterval: online ? 15_000 : false, retry: false,
  });
}

export function useReviewComments(serverId: string, workspaceId: string, online: boolean) {
  const key = reviewCommentsKey(serverId, workspaceId);
  const list = useRpc(listReviewComments);
  const save = useRpc(saveReviewComment);
  const update = useRpc(updateReviewComment);
  const send = useRpc(sendReviewComments);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({ queryKey: key, queryFn: () => list({ serverId, workspaceId }), enabled: online, staleTime: 5_000, retry: false });

  async function run<T extends { comments: ReviewComment[] }>(work: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      queryClient.setQueryData(key, { comments: result.comments });
      return result;
    } catch (cause) { setError(message(cause)); return null; }
    finally { setBusy(false); }
  }

  return {
    comments: query.data?.comments ?? [],
    loadError: query.isError ? message(query.error) : null,
    busy, error, clearError: () => setError(null),
    save: (input: { commentId?: string; path: string; anchor: CommentAnchor | null; body: string }) => run(() => save({ serverId, workspaceId, ...input })),
    update: (commentId: string, action: Action) => run(() => update({ serverId, workspaceId, commentId, action })),
    send: async (input: { agentId: string; commentIds: string[]; workspaceName: string; scopeLabel: string }) => {
      const result = await run(() => send({ serverId, workspaceId, ...input }));
      if (result?.error) setError(`Delivery unconfirmed: ${result.error}. Check the agent's chat, then mark each comment as arrived or not.`);
      return result;
    },
  };
}

function statusChip(comment: ReviewComment, agentName: (id: string | null) => string, colors: Colors) {
  if (comment.delivery?.phase === "sending") return <Chip label={comment.delivery.error ? "DELIVERY UNCONFIRMED" : "SENDING"} color={colors.statusWarning} colors={colors} />;
  if (comment.status === "sent") return <Chip label={`SENT TO ${agentName(comment.sentTo).toUpperCase()}`} color={colors.accent} colors={colors} />;
  if (comment.status === "resolved") return <Chip label="RESOLVED" color={colors.statusSuccess} colors={colors} />;
  return <Chip label="NOT SENT" colors={colors} />;
}

export function CommentCard({ comment, colors, agentName, busy, onAction, onEdit, onOpen, showPath }: {
  comment: ReviewComment; colors: Colors; agentName: (id: string | null) => string; busy: boolean;
  onAction: (action: Action) => void; onEdit?: () => void; onOpen?: () => void; showPath?: boolean;
}) {
  const unconfirmed = comment.delivery?.phase === "sending";
  const where = comment.anchor ? `Line ${comment.anchor.line}${comment.anchor.side === "old" ? " (removed)" : ""}` : "Whole file";
  return <View style={{ marginVertical: 4, marginLeft: showPath ? 0 : 46, borderColor: colors.border, borderLeftColor: comment.status === "open" ? colors.accent : colors.border, borderWidth: 1, borderLeftWidth: 3, borderRadius: 7, padding: 9, gap: 5, backgroundColor: colors.surface1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      {statusChip(comment, agentName, colors)}
      <Text style={{ color: colors.foregroundMuted, fontSize: 11, flex: 1 }}>{showPath ? `${comment.path} · ` : ""}{where} · {formatDateTime(comment.createdAt)}</Text>
    </View>
    {showPath && comment.anchor?.text.trim() ? <Text numberOfLines={2} style={[mono, { color: colors.foregroundMuted, fontSize: 11 }]}>{comment.anchor.text.trim()}</Text> : null}
    <Text selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{comment.body}</Text>
    {comment.delivery?.error ? <Text style={{ color: colors.statusWarning, fontSize: 11 }}>{comment.delivery.error}</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
      {onOpen ? <LinkButton label="Show in diff" onPress={onOpen} colors={colors} /> : null}
      {comment.status === "open" && !comment.delivery ? <>
        {onEdit ? <LinkButton label="Edit" onPress={onEdit} colors={colors} disabled={busy} /> : null}
        <LinkButton label="Delete" onPress={() => onAction("delete")} colors={colors} disabled={busy} tone={colors.statusDanger} />
      </> : null}
      {unconfirmed ? <>
        <LinkButton label="It arrived" onPress={() => onAction("confirm-sent")} colors={colors} disabled={busy} />
        <LinkButton label="It didn't arrive" onPress={() => onAction("confirm-not-sent")} colors={colors} disabled={busy} />
      </> : null}
      {comment.status === "sent" && !unconfirmed ? <LinkButton label="Resolve" onPress={() => onAction("resolve")} colors={colors} disabled={busy} /> : null}
      {comment.status === "resolved" ? <LinkButton label="Reopen" onPress={() => onAction("reopen")} colors={colors} disabled={busy} /> : null}
    </View>
  </View>;
}

export function CommentComposer({ label, initial, colors, busy, onSave, onCancel, indent = true }: {
  label: string; initial?: string; colors: Colors; busy: boolean; onSave: (body: string) => void; onCancel: () => void; indent?: boolean;
}) {
  const [body, setBody] = useState(initial ?? "");
  return <View style={{ marginVertical: 4, marginLeft: indent ? 46 : 0, borderColor: colors.accent, borderWidth: 1, borderRadius: 7, padding: 9, gap: 6, backgroundColor: colors.surface1 }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{label}</Text>
    <TextInput accessibilityLabel={label} value={body} onChangeText={setBody} editable={!busy} multiline autoFocus placeholder="What should change here?" placeholderTextColor={colors.foregroundMuted}
      style={{ color: colors.foreground, backgroundColor: colors.surface0, borderColor: colors.border, borderWidth: 1, borderRadius: 6, padding: 8, minHeight: 64, fontSize: 13, textAlignVertical: "top" }} />
    <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
      <Pressable accessibilityRole="button" disabled={busy} onPress={onCancel} style={{ minHeight: 36, paddingHorizontal: 12, justifyContent: "center" }}><Text style={{ color: colors.foreground, fontSize: 12 }}>Cancel</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Save comment" disabled={busy || !body.trim()} onPress={() => onSave(body.trim())}
        style={{ minHeight: 36, paddingHorizontal: 12, justifyContent: "center", borderRadius: 7, backgroundColor: body.trim() ? colors.accent : colors.surface2 }}>
        <Text style={{ color: body.trim() ? colors.accentForeground : colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{busy ? "Saving…" : "Save comment"}</Text>
      </Pressable>
    </View>
  </View>;
}

/** Choose an agent in this workspace and send every unsent comment to its chat. contextLine says whose a sub-agent is. */
export function SendBar({ agents, agentId, onChooseAgent, pending, busy, onSend, colors, contextLine }: {
  agents: ReviewAgent[]; agentId: string | null; onChooseAgent: (id: string) => void; pending: number; busy: boolean; onSend: () => void; colors: Colors;
  contextLine?: (agent: ReviewAgent) => string | null;
}) {
  const chosen = agents.find(agent => agent.id === agentId) ?? null;
  const chosenContext = chosen && contextLine ? contextLine(chosen) : null;
  const ready = chosen?.status === "idle";
  return <View style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Send ${plural(pending, "comment")} to ${chosen?.name ?? "an agent"}`} disabled={busy || !pending || !ready} onPress={onSend}
        style={{ minHeight: 40, paddingHorizontal: 14, justifyContent: "center", borderRadius: 7, backgroundColor: pending && ready ? colors.accent : colors.surface2, opacity: busy ? 0.6 : 1 }}>
        <Text style={{ color: pending && ready ? colors.accentForeground : colors.foregroundMuted, fontSize: 13, fontWeight: "700" }}>
          {busy ? "Sending…" : pending ? `Send ${plural(pending, "comment")} to ${chosen?.name ?? "agent"}` : "No unsent comments"}
        </Text>
      </Pressable>
      {chosen && !ready ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{chosen.name} is {chosen.status}; send when it's idle.</Text> : null}
      {!agents.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No agents in this workspace to send to.</Text> : null}
    </View>
    {chosenContext && agents.length === 1 ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>↳ {chosenContext}</Text> : null}
    {agents.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
      {/* Sub-agents follow their parent, marked ↳; one shown apart from its parent says whose it is. */}
      {groupAgents(agents).flatMap(node => flattenAgentTree(node)).map(({ agent, nested }) => <Pressable key={agent.id} accessibilityRole="radio" accessibilityState={{ selected: agent.id === agentId }}
        accessibilityLabel={`${agent.name}, ${agent.status}${nested ? ", sub-agent of the agent before it" : ""}`} onPress={() => onChooseAgent(agent.id)}
        style={{ minHeight: 32, paddingHorizontal: 9, justifyContent: "center", borderRadius: 6, borderWidth: 1, borderColor: agent.id === agentId ? colors.accent : colors.border }}>
        <Text style={{ color: agent.id === agentId ? colors.foreground : colors.foregroundMuted, fontSize: 11 }}>{nested ? "↳ " : ""}{agent.name} · {agent.status}</Text>
        {!nested && contextLine?.(agent) ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 10, maxWidth: 280 }}>↳ {contextLine(agent)}</Text> : null}
      </Pressable>)}
    </ScrollView> : null}
  </View>;
}
