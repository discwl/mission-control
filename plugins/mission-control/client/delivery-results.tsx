import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { dismissDeliveryResult, type DeliveryResult } from "../shared/pull-request";
import { formatDateTime } from "./date-time";
import { message, Outcome, plural, refreshAfterDelivery } from "./merge-action";
import { CleanupOutcome, PullRequestOutcome } from "./pull-request-action";

type Colors = PluginSurfaceProps["theme"]["colors"];

const kindLabels: Record<DeliveryResult["kind"], { running: string; done: string }> = {
  merge: { running: "MERGING", done: "MERGE RESULT" },
  "pull-request": { running: "OPENING PR", done: "PULL REQUEST" },
  cleanup: { running: "CLEANING UP", done: "CLEAN UP" },
};

/** One line for a finished result: what happened, and whether a step needs a look. */
function outcomeLine(entry: DeliveryResult) {
  if (entry.state === "failed" || !entry.result) return `Stopped with an error: ${entry.error ?? "unknown error"}`;
  const needsLook = (steps: readonly { state: string }[], what: string) => {
    const problems = steps.filter(step => step.state !== "done").length;
    return problems ? `; ${plural(problems, what)} need${problems === 1 ? "s" : ""} a look` : "";
  };
  if (entry.kind === "merge") {
    const result = entry.result;
    if (result.outcome === "refused") return `Merge refused: ${result.reason}`;
    if (result.outcome === "conflict") {
      return result.state === "aborted" ? "Merge needs you: it was aborted, and the main checkout is as it was."
        : result.state === "unknown" ? "Merge needs you: the main checkout's state is unknown, so nothing was undone. Check it before doing anything else."
          : result.state === "not-restored" ? "Merge needs you: the main checkout isn't back where it was. Check it before doing anything else."
            : "Merge needs you: see the steps.";
    }
    return `Merged into ${result.targetBranch} as ${result.mergeCommit.slice(0, 7)}${needsLook(result.steps, "cleanup step")}.`;
  }
  if (entry.kind === "pull-request") {
    const result = entry.result;
    if (result.outcome === "refused") return `Open PR refused: ${result.reason}`;
    if (result.outcome === "failed") return `Not opened: ${result.reason}`;
    if (result.outcome === "dry-run") return "Dry run; nothing changed.";
    return `Opened draft pull request #${result.number}${needsLook(result.steps, "step")}.`;
  }
  const result = entry.result;
  return result.outcome === "refused" ? `Clean up refused: ${result.reason}` : `Cleaned up${needsLook(result.steps, "step")}.`;
}

function outcomeTone(entry: DeliveryResult, colors: Colors) {
  if (entry.state === "running") return colors.accent;
  const result = entry.result;
  if (entry.state === "failed" || !result || result.outcome === "refused") return colors.statusDanger;
  if (result.outcome === "conflict" || result.outcome === "failed") return colors.statusWarning;
  if ("steps" in result && result.steps.some(step => step.state !== "done")) return colors.statusWarning;
  return colors.statusSuccess;
}

/**
 * A Merge, Open PR or Clean up result in Attention: its current step while it runs, then what happened with
 * each step's outcome. It stays, even after the task leaves the Ready list, until the user dismisses it.
 */
export function DeliveryResultCard({ entry, serverId, online, colors }: { entry: DeliveryResult; serverId: string; online: boolean; colors: Colors }) {
  const dismiss = useRpc(dismissDeliveryResult);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const running = entry.state === "running";
  const tone = outcomeTone(entry, colors);
  async function forget() {
    setError(null);
    try { await dismiss({ serverId, resultId: entry.resultId }); }
    catch (cause) { setError(message(cause)); }
    finally { refreshAfterDelivery(queryClient, serverId, entry.taskId); }
  }
  return <View style={{ borderColor: colors.border, borderWidth: 1, borderLeftWidth: 3, borderLeftColor: tone, borderRadius: 7, padding: 9, gap: 4, backgroundColor: colors.surface0 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={{ color: tone, fontSize: 11, fontWeight: "700" }}>{running ? kindLabels[entry.kind].running : kindLabels[entry.kind].done}</Text>
      <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>{entry.taskTitle}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{formatDateTime(entry.finishedAt ?? entry.startedAt)}</Text>
    </View>
    <Text numberOfLines={open ? undefined : 2} style={{ color: running ? colors.foregroundMuted : colors.foreground, fontSize: 12 }}>
      {running ? `${entry.step}… · started ${formatDateTime(entry.startedAt)}` : outcomeLine(entry)}
    </Text>
    {open && entry.result ? entry.kind === "merge" ? <Outcome result={entry.result} colors={colors} />
      : entry.kind === "pull-request" ? <PullRequestOutcome result={entry.result} colors={colors} />
        : <CleanupOutcome result={entry.result} colors={colors} /> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
    {running ? null : <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
      {entry.result ? <CompactLink label={open ? "Hide steps" : "Steps"} expanded={open} colors={colors} onPress={() => setOpen(!open)} /> : null}
      <CompactLink label="Dismiss" icon="X" accessibilityLabel={`Dismiss the result for ${entry.taskTitle}`} disabled={!online} colors={colors} onPress={() => void forget()} />
    </View>}
  </View>;
}
import { CompactLink } from "./compact-link";
