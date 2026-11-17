import { useRpc as useLocalRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { reopenDeliveredTask, type TaskRecord } from "../shared/tasks";
import { readFleet } from "../shared/fleet";
import { startReopenedPipeline } from "../shared/pipeline";
import { listCopies } from "./host-bridge";
import { findCoordinatingFleet } from "./coordinating-fleet";
import { CompactLink } from "./compact-link";
import { useRpc } from "./host-rpc";

export function ReopenDeliveredTask({ task, serverId, workspaceId, colors, refresh }: {
  task: TaskRecord; serverId: string; workspaceId: string; colors: PluginSurfaceProps["theme"]["colors"]; refresh(): void;
}) {
  const reopen = useRpc(reopenDeliveredTask);
  const read = useLocalRpc(readFleet);
  const start = useLocalRpc(startReopenedPipeline);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<TaskRecord | null>(null);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  const [choices, setChoices] = useState<{ id: string; name: string }[]>([]);
  const sending = useRef(false);
  const fix = task.status === "ready" ? task : ready;
  async function submit(choice?: string) {
    if (sending.current || started || (!fix && !reason.trim())) return;
    sending.current = true;
    setBusy(true);
    setError("");
    let reopened = fix;
    try {
      if (!reopened) {
        reopened = await reopen({ serverId, workspaceId, taskId: task.taskId, expectedUpdatedAt: task.updatedAt, reason: reason.trim() });
        setReady(reopened);
      }
      const reopenedAt = reopened.deliveryHistory?.at(-1)?.reopenedAt;
      if (!reopenedAt) throw new Error("Refresh the task to load its fix workspace.");
      const { managed, fleet, copy } = await findCoordinatingFleet(serverId, () => read({}), listCopies());
      if (!managed) throw new Error("Reconnect the coordinating computer and select Start fix here.");
      const coordinators = fleet.coordinators.filter(item => item.remoteServerId === serverId);
      const previous = [...fleet.state.pipelines].reverse().find(row => row.taskId === task.taskId && row.remoteServerId === serverId && coordinators.some(item => item.agentId === row.coordinatorId));
      const coordinatorId = choice ?? previous?.coordinatorId ?? (coordinators.length === 1 ? coordinators[0].agentId : undefined);
      if (!coordinatorId) {
        setChoices(coordinators.map(item => ({ id: item.agentId, name: item.name })));
        return;
      }
      const input = { coordinatorId, remoteServerId: serverId, taskId: task.taskId, reopenedAt, expectedRevision: fleet.state.revision };
      if (copy) {
        if (!copy.supports(startReopenedPipeline.name)) throw new Error("Update Mission Control on the coordinating computer and select Start fix here.");
        await copy.rpc(startReopenedPipeline.name, input);
      } else await start(input);
      setStarted(true);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setError(reopened ? `Task reopened. ${detail}` : detail);
    } finally {
      sending.current = false;
      setBusy(false);
      refresh();
    }
  }
  if (started) return <Text style={{ color: colors.foreground }}>Fix enrolled. Follow its runner in Orchestrator.</Text>;
  return <View style={{ gap: 8 }}>
    {!fix ? <CompactLink label={open ? "Cancel reopening" : "Reopen to fix…"} colors={colors} disabled={busy} expanded={open} onPress={() => setOpen(!open)} /> : null}
    {open && !fix ? <>
      <Text style={{ color: colors.foreground }}>What needs fixing?</Text>
      <TextInput accessibilityLabel="What needs fixing?" multiline maxLength={4000} editable={!busy} value={reason} onChangeText={setReason}
        placeholder="Describe the issue and the expected result." placeholderTextColor={colors.foregroundMuted}
        style={{ minHeight: 72, padding: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 6, color: colors.foreground }} />
      <CompactLink label={busy ? "Reopening…" : "Reopen and start Standard fix"} colors={colors} disabled={busy || !reason.trim()} onPress={() => void submit()} />
    </> : null}
    {fix && !choices.length ? <CompactLink label={busy ? "Starting fix…" : "Start fix"} colors={colors} disabled={busy} onPress={() => void submit()} /> : null}
    {fix && choices.length ? <Text style={{ color: colors.foreground }}>Choose the orchestrator to run the fix.</Text> : null}
    {choices.map(choice => <CompactLink key={choice.id} label={choice.name} disabled={busy} colors={colors} onPress={() => void submit(choice.id)} />)}
    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>{error}</Text> : null}
  </View>;
}
