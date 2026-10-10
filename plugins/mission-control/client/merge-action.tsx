import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { AppModal as Modal } from "./app-modal";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { decisionsKey } from "../shared/decisions";
import { checkMerge, listMergeReady, mergeCheckKey, mergeReadyKey, runMerge, type MergePlan, type MergeResult, type MergeStep } from "../shared/merge";
import { deliveryResultsKey, listDeliveryResults, pullRequestCheckKey, pullRequestsKey } from "../shared/pull-request";
import { DeliveryTextFields, useDeliveryText, type DeliveryTextDraft } from "./delivery-text";
import { defaultText } from "./delivery-text-model";

type Colors = PluginSurfaceProps["theme"]["colors"];

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
export const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Tasks whose latest review is approved, on this installation's host. */
export function useMergeReady(serverId: string, online: boolean) {
  const read = useRpc(listMergeReady);
  return useQuery({ queryKey: mergeReadyKey(serverId), queryFn: () => read({ serverId }), enabled: online, staleTime: 10_000, refetchInterval: online ? 20_000 : false, retry: false });
}

/** Merge, Open PR and Clean up results, kept until dismissed; polled every few seconds while one is running. */
export function useDeliveryResults(serverId: string, online: boolean) {
  const read = useRpc(listDeliveryResults);
  return useQuery({
    queryKey: deliveryResultsKey(serverId), queryFn: () => read({ serverId }), enabled: online, staleTime: 2_000, retry: false,
    refetchInterval: query => !online ? false : query.state.data?.results.some(entry => entry.state === "running") ? 3_000 : 20_000,
  });
}

/** Everything a merge, pull request or cleanup can change: its checks, the ready list, results, pull requests, decisions and the roster. */
export function refreshAfterDelivery(queryClient: ReturnType<typeof useQueryClient>, serverId: string, taskId: string) {
  for (const queryKey of [mergeCheckKey(serverId, taskId), pullRequestCheckKey(serverId, taskId), mergeReadyKey(serverId), deliveryResultsKey(serverId), pullRequestsKey(serverId), decisionsKey(serverId), ["mission-control", "roster", serverId]]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

export function Line({ children, colors, tone, strong = false }: { children: ReactNode; colors: Colors; tone?: string; strong?: boolean }) {
  return <Text style={{ color: tone ?? colors.foreground, fontSize: 13, lineHeight: 19, fontWeight: strong ? "600" : "400" }}>{children}</Text>;
}

/** Each step's outcome: ✓ done, – skipped, ✕ failed. */
export function StepLines({ steps, colors }: { steps: readonly MergeStep[]; colors: Colors }) {
  return <>{steps.map(step => <Text key={step.label} style={{ color: step.state === "failed" ? colors.statusDanger : step.state === "skipped" ? colors.statusWarning : colors.foreground, fontSize: 13, lineHeight: 19 }}>
    {step.state === "done" ? "✓" : step.state === "skipped" ? "–" : "✕"} {step.label}: {step.detail}
  </Text>)}</>;
}

export function FileList({ files, total, colors }: { files: readonly string[]; total: number; colors: Colors }) {
  return <ScrollView style={{ maxHeight: 140, borderColor: colors.border, borderWidth: 1, borderRadius: 6 }} contentContainerStyle={{ padding: 8, gap: 2 }} nestedScrollEnabled>
    {files.map(file => <Text key={file} numberOfLines={1} style={{ color: colors.foreground, fontSize: 12, fontFamily: "monospace" }}>{file}</Text>)}
    {total > files.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>and {total - files.length} more</Text> : null}
  </ScrollView>;
}

/** Exactly what a merge will do, from the server's plan, with the commit message the user confirms. */
function PlanSteps({ plan, draft, busy, colors }: { plan: MergePlan; draft: DeliveryTextDraft; busy: boolean; colors: Colors }) {
  const commits = plan.commitsAhead + (plan.uncommittedCount ? 1 : 0);
  return <View style={{ gap: 10 }}>
    <View style={{ gap: 4 }}>
      <Line colors={colors} strong>1. Commit the task's uncommitted work</Line>
      {plan.uncommittedCount ? <>
        <Line colors={colors}>Commit {plural(plan.uncommittedCount, "file")} on {plan.taskBranch} with this message:</Line>
        <DeliveryTextFields draft={draft} colors={colors} disabled={busy} />
        <FileList files={plan.uncommittedFiles} total={plan.uncommittedCount} colors={colors} />
      </> : <Line colors={colors} tone={colors.foregroundMuted}>Nothing uncommitted; this step is skipped.</Line>}
      {plan.undoneCount ? <>
        <Line colors={colors} tone={colors.foregroundMuted}>Git also lists {plural(plan.undoneCount, "file")} as changed whose content matches {plan.taskBranch}, such as a staged change that was undone in the files. {plan.uncommittedCount ? "The commit brings the staging area in line with the files." : "They are unstaged; no file changes."} Nothing of them is merged:</Line>
        <FileList files={plan.undoneFiles} total={plan.undoneCount} colors={colors} />
      </> : null}
    </View>
    <View style={{ gap: 4 }}>
      <Line colors={colors} strong>2. Merge</Line>
      <Line colors={colors}>Merge {plan.taskBranch} ({plural(commits, "commit")}) into {plan.targetBranch} in {plan.mainCheckout} with --no-ff, as "{plan.mergeMessage}".</Line>
      <Line colors={colors} tone={colors.foregroundMuted}>On any conflict, the merge is aborted, {plan.targetBranch} stays as it was, and the conflicting files are listed.</Line>
    </View>
    <View style={{ gap: 4 }}>
      <Line colors={colors} strong>3. After a clean merge</Line>
      <Line colors={colors}>• Clear the worktree workspace's Review marks.</Line>
      <Line colors={colors}>• Set the task to delivered and add a line to its status.md.</Line>
      <Line colors={colors}>• {plan.agentId ? "Send the task's agent a short note of what was done and what comes next." : "No live agent to tell; no note is sent."}</Line>
      <Line colors={colors}>• Archive the worktree workspace in Paseo. This closes its agents and terminals and may remove the worktree folder.</Line>
      <Line colors={colors}>• Delete the merged branch {plan.taskBranch}.</Line>
    </View>
    <Line colors={colors} tone={colors.foregroundMuted}>Nothing is pushed, forced, rebased or stashed, and no other branch changes. A merge that takes longer than about 20 seconds carries on in the background. Attention keeps its result, with each step's outcome, until you dismiss it.</Line>
  </View>;
}

export function Outcome({ result, colors }: { result: MergeResult; colors: Colors }) {
  if (result.outcome === "refused") return <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 13 }}>Merge refused: {result.reason}</Text>;
  if (result.outcome === "conflict") {
    return <View accessibilityRole="alert" style={{ gap: 6 }}>
      <Line colors={colors} tone={colors.statusWarning} strong>Merge needs you</Line>
      <Line colors={colors}>{result.detail}</Line>
      {result.files.length ? <FileList files={result.files} total={result.files.length} colors={colors} /> : null}
    </View>;
  }
  return <View style={{ gap: 6 }}>
    <Line colors={colors} tone={colors.statusSuccess} strong>Merged into {result.targetBranch} as {result.mergeCommit.slice(0, 7)}.</Line>
    <StepLines steps={result.steps} colors={colors} />
  </View>;
}

/** The task a merge dialog is about, with the plan frozen when the user pressed Merge. */
export type MergeTarget = { taskId: string; plan: MergePlan };

/**
 * Attention's Merge button for a task whose review is approved. It is enabled only when every server
 * check passes; otherwise it names the first check that failed, with all checks one tap away. Pressing it
 * opens Attention's MergeDialog, which outlives this row once the merged task is delivered and leaves the list.
 */
export function MergeButton({ serverId, taskId, taskTitle, online, colors, onOpen }: {
  serverId: string; taskId: string; taskTitle: string; online: boolean; colors: Colors; onOpen: (target: MergeTarget) => void;
}) {
  const check = useRpc(checkMerge);
  const [showChecks, setShowChecks] = useState(false);
  const status = useQuery({ queryKey: mergeCheckKey(serverId, taskId), queryFn: () => check({ serverId, taskId }), enabled: online, staleTime: 10_000, refetchInterval: online ? 30_000 : false, retry: false });
  const ready = online && status.data?.ready === true && status.data.plan !== null;
  const checks = status.data?.checks ?? [];
  const failing = checks.filter(item => !item.ok);
  const note = !online ? "Host offline."
    : status.isPending ? "Checking whether it can merge…"
      : status.isError ? `Couldn't check the merge: ${message(status.error)}`
        : failing.length ? `Can't merge yet: ${failing[0].detail}${failing.length > 1 ? ` (+${failing.length - 1} more)` : ""}` : "All checks pass.";

  return <View style={{ gap: 4, flexShrink: 1 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Merge ${taskTitle}`} accessibilityState={{ disabled: !ready }} disabled={!ready}
        onPress={() => { if (status.data?.plan) onOpen({ taskId, plan: status.data.plan }); }}
        style={{ minHeight: 36, paddingHorizontal: 12, justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: ready ? colors.accent : colors.border, backgroundColor: ready ? colors.accent : "transparent", opacity: ready ? 1 : 0.55 }}>
        <Text style={{ color: ready ? colors.accentForeground : colors.foreground, fontWeight: "600", fontSize: 12 }}>Merge</Text>
      </Pressable>
      <Text numberOfLines={showChecks ? undefined : 2} style={{ color: status.isError ? colors.statusDanger : colors.foregroundMuted, fontSize: 11, flex: 1, minWidth: 140 }}>{note}</Text>
      {checks.length ? <CompactLink label={showChecks ? "Hide checks" : "Checks"} expanded={showChecks} accessibilityLabel={`Merge checks for ${taskTitle}`} colors={colors} onPress={() => setShowChecks(!showChecks)} /> : null}
    </View>
    {showChecks ? checks.map(item => <Text key={item.id} style={{ color: item.ok ? colors.foreground : colors.statusDanger, fontSize: 12, lineHeight: 17 }}>{item.ok ? "✓" : "✕"} {item.label}: {item.detail}</Text>) : null}
  </View>;
}

/**
 * The confirmation and result dialog, rendered once by Attention. It confirms exactly what will happen,
 * runs the merge with the frozen plan (the server refuses if anything changed), and then stays open with
 * the outcome and every cleanup step until the user closes it. A merge that outlasts the reply carries on
 * in the background; the dialog follows it while open. Either way Attention keeps its card until dismissed.
 */
export function MergeDialog({ serverId, online, colors, target, onClose }: { serverId: string; online: boolean; colors: Colors; target: MergeTarget | null; onClose: () => void }) {
  const run = useRpc(runMerge);
  const queryClient = useQueryClient();
  const results = useDeliveryResults(serverId, online);
  const toast = useToast();
  const [result, setResult] = useState<MergeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const lock = useRef(false);
  const plan = target?.plan ?? null;
  // The commit message: Mission Control's default, then what a small model writes from paseo.json, then the user's edits.
  const needs = { commit: (plan?.uncommittedCount ?? 0) > 0, pullRequest: false };
  const draft = useDeliveryText({
    serverId, taskId: target?.taskId ?? null, workspaceId: plan?.worktreeWorkspaceId ?? null, planKey: target ? `${target.taskId}:${target.plan.fingerprint}` : null,
    needs, defaults: plan ? defaultText(needs, plan) : {},
  });
  const pending = pendingId ? results.data?.results.find(entry => entry.resultId === pendingId && entry.kind === "merge") ?? null : null;
  // A background merge's result, once it finished while the dialog was open.
  const shown = result ?? (pending?.kind === "merge" ? pending.result : null) ?? null;
  const failed = pending?.state === "failed" ? pending.error : null;

  function announce(outcome: MergeResult) {
    if (outcome.outcome !== "merged") return;
    const problems = outcome.steps.filter(step => step.state !== "done").length;
    toast.show(problems ? `Merged into ${outcome.targetBranch}; ${plural(problems, "cleanup step")} need${problems === 1 ? "s" : ""} a look` : `Merged into ${outcome.targetBranch}`, { variant: problems ? "warning" : "success" });
  }

  async function confirm() {
    if (!target || lock.current || draft.waiting || draft.problem) return;
    const { taskId, plan: frozen } = target;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const reply = await run({ serverId, taskId, fingerprint: frozen.fingerprint, ...(draft.shown.commitMessage !== undefined ? { commitMessage: draft.shown.commitMessage } : {}) });
      if (reply.outcome === "running") setPendingId(reply.resultId);
      else { setResult(reply); announce(reply); }
    } catch (cause) { setError(message(cause)); }
    finally {
      lock.current = false;
      setBusy(false);
      refreshAfterDelivery(queryClient, serverId, taskId);
    }
  }

  const close = () => {
    if (lock.current) return;
    // Attention keeps the result card, with each step, until it is dismissed there.
    setResult(null); setError(null); setPendingId(null); onClose();
  };
  const blocked = busy || !online || draft.waiting || draft.problem !== null;
  const title = shown ? (shown.outcome === "conflict" ? "Merge needs you" : shown.outcome === "merged" ? "Merged" : "Merge refused")
    : failed ? "Merge stopped" : pendingId ? "Merging in the background" : "Merge this task?";

  return <Modal colors={colors} title={title} open={target !== null} onOpenChange={open => { if (!open) close(); }}>
    <Modal.Content>
      <View style={{ gap: 12 }}>
        <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600" }}>{plan?.taskTitle}</Text>
        {shown ? <Outcome result={shown} colors={colors} />
          : failed ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 13 }}>The merge stopped with an error: {failed}</Text>
            : pendingId ? <Line colors={colors}>The merge is taking a while, so it carries on in the background{pending ? ` (${pending.step.toLowerCase()})` : ""}. You can close this; Attention shows its progress, then keeps its result until you dismiss it.</Line>
              : plan ? <PlanSteps plan={plan} draft={draft} busy={busy} colors={colors} /> : null}
        {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 10 }}>
          <Pressable accessibilityRole="button" disabled={busy} onPress={close} style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: "center" }}>
            <Text style={{ color: colors.foreground }}>{shown || failed || pendingId ? "Close" : "Cancel"}</Text>
          </Pressable>
          {shown || failed || pendingId ? null : <Pressable accessibilityRole="button" accessibilityLabel="Confirm merge" disabled={blocked} onPress={() => void confirm()}
            style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: colors.accent, backgroundColor: colors.accent, opacity: blocked ? 0.5 : 1 }}>
            <Text style={{ color: colors.accentForeground, fontWeight: "600" }}>{busy ? "Merging…" : draft.waiting ? "Writing…" : "Merge"}</Text>
          </Pressable>}
        </View>
      </View>
    </Modal.Content>
  </Modal>;
}
import { CompactLink } from "./compact-link";
