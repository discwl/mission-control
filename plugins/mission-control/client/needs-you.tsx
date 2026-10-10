import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { decisionsKey, listDecisions, resendDecision, type DecisionEntry } from "../shared/decisions";
import { DecisionCard, outcomeLabel, type DecisionActions } from "./decision-card";
import { formatDateTime } from "./date-time";
import { CompactLink } from "./compact-link";

type Colors = PluginSurfaceProps["theme"]["colors"];
type Actions = DecisionActions;

/** Decisions live in this installation's vault, so they are read from its own host only. */
export function useDecisions(serverId: string, enabled: boolean) {
  const read = useRpc(listDecisions);
  return useQuery({
    queryKey: decisionsKey(serverId),
    queryFn: () => read({ serverId }),
    enabled,
    staleTime: 10_000,
    refetchInterval: enabled ? 20_000 : false,
    retry: false,
  });
}

function RecentDecision({ entry, serverId, colors, actions }: { entry: DecisionEntry; serverId: string; colors: Colors; actions: Actions }) {
  const { decision } = entry;
  const resend = useRpc(resendDecision);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phase = decision.resume?.phase;
  const delivery = phase === "sent" ? "Sent to agent" : phase === "sending" ? "Delivery unconfirmed — open the agent to check" : "Saved, not sent";
  async function retry() {
    setBusy(true);
    setError(null);
    try { await resend({ serverId, workspaceId: decision.workspaceId, taskId: decision.taskId, runId: decision.runId, decisionId: decision.decisionId, expectedRevision: entry.revision }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { void queryClient.invalidateQueries({ queryKey: decisionsKey(serverId) }); setBusy(false); }
  }
  return <View style={{ borderColor: colors.border, borderWidth: 1, borderRadius: 7, padding: 9, gap: 3 }}>
    <Text style={{ color: colors.foreground, fontSize: 13 }}><Text style={{ fontWeight: "600" }}>{outcomeLabel[decision.status]}</Text> · {decision.kind} · {entry.taskTitle}</Text>
    <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{decision.resolvedAt ? formatDateTime(decision.resolvedAt) : ""}{decision.note ? ` · “${decision.note}”` : ""}</Text>
    <Text style={{ color: phase === "sent" ? colors.foregroundMuted : colors.statusWarning, fontSize: 11 }}>{delivery}{decision.resume?.error && phase !== "sent" ? `: ${decision.resume.error}` : ""}</Text>
    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {phase === "pending" ? <CompactLink label={busy ? "Sending…" : "Send to agent"} colors={colors} disabled={busy} onPress={() => void retry()} /> : null}
      {decision.agentId ? <CompactLink label="Open agent" colors={colors} onPress={() => actions.openAgent(decision.agentId!)} /> : null}
    </View>
  </View>;
}

// showHeading=false lets a host view, such as Attention, title the section itself; brief tightens the cards' spacing.
export function NeedsYou({ serverId, hostLabel, online, colors, actions, showHeading = true, brief = false }: { serverId: string; hostLabel: string; online: boolean; colors: Colors; actions: Actions; showHeading?: boolean; brief?: boolean }) {
  const query = useDecisions(serverId, online);
  const [showRecent, setShowRecent] = useState(false);
  const open = query.data?.open ?? [];
  const recent = query.data?.recent ?? [];
  return <View style={{ gap: 9 }}>
    {showHeading ? <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>Needs you{query.data ? ` (${open.length})` : ""}</Text> : null}
    {!online ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>This host is offline; its decisions are unavailable.</Text> : null}
    {online && query.isPending ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Loading decisions…</Text> : null}
    {query.isError ? <Text style={{ color: colors.statusDanger, fontSize: 12 }}>Decisions unavailable: {query.error instanceof Error ? query.error.message : String(query.error)}</Text> : null}
    {query.data && open.length === 0 ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No plan or review decisions are waiting on {hostLabel}.</Text> : null}
    {open.map(entry => <DecisionCard key={`${entry.decision.decisionId}:${entry.revision}`} entry={entry} serverId={serverId} hostLabel={hostLabel} colors={colors} actions={actions} brief={brief} />)}
    {recent.length ? <CompactLink label={`${showRecent ? "Hide" : "Show"} recent decisions (${recent.length})`} expanded={showRecent} colors={colors} onPress={() => setShowRecent(!showRecent)} /> : null}
    {showRecent ? recent.map(entry => <RecentDecision key={entry.decision.decisionId} entry={entry} serverId={serverId} colors={colors} actions={actions} />) : null}
    <Text style={{ color: colors.foregroundMuted, fontSize: 11, marginTop: 4 }}>Remote hosts' decisions appear once Mission Control is installed there.</Text>
  </View>;
}
