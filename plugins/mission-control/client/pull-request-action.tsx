import { CompactLink, CompactExternalLink } from "./compact-link";
import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { AppModal as Modal } from "./app-modal";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { forgeLabels } from "../shared/forges";
import {
  checkPullRequest, listPullRequests, planCleanup, pullRequestCheckKey, pullRequestsKey, runCleanup, runPullRequest,
  type CleanupResult, type DeliveryCommand, type PullRequestPlan, type PullRequestResult, type PullRequestState, type TrackedPullRequest,
} from "../shared/pull-request";
import { formatDateTime } from "./date-time";
import { DeliveryTextFields, useDeliveryText, type DeliveryTextDraft } from "./delivery-text";
import { defaultText } from "./delivery-text-model";
import { FileList, Line, message, plural, refreshAfterDelivery, StepLines, useDeliveryResults } from "./merge-action";

type Colors = PluginSurfaceProps["theme"]["colors"];

function Commands({ commands, colors }: { commands: readonly DeliveryCommand[]; colors: Colors }) {
  return <ScrollView style={{ maxHeight: 220, borderColor: colors.border, borderWidth: 1, borderRadius: 6 }} contentContainerStyle={{ padding: 8, gap: 6 }} nestedScrollEnabled>
    {commands.map((command, index) => <View key={`${command.step}-${index}`} style={{ gap: 1 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{command.step}</Text>
      <Text selectable style={{ color: colors.foreground, fontSize: 12, fontFamily: "monospace" }}>{command.text}</Text>
    </View>)}
  </ScrollView>;
}

/** Exactly what Open PR will do, from the server's plan, with the text the user confirms. */
function PlanSteps({ plan, draft, busy, colors }: { plan: PullRequestPlan; draft: DeliveryTextDraft; busy: boolean; colors: Colors }) {
  const edited = draft.shown.title !== plan.title || draft.shown.body !== plan.body || (draft.shown.commitMessage !== undefined && draft.shown.commitMessage !== plan.commitMessage);
  return <View style={{ gap: 10 }}>
    <View style={{ gap: 4 }}>
      <Line colors={colors} strong>1. Commit the task's uncommitted work</Line>
      {plan.uncommittedCount ? <>
        <Line colors={colors}>Commit {plural(plan.uncommittedCount, "file")} on {plan.taskBranch} with this message:</Line>
        <DeliveryTextFields draft={draft} colors={colors} disabled={busy} only={["commitMessage"]} quiet />
        <FileList files={plan.uncommittedFiles} total={plan.uncommittedCount} colors={colors} />
      </> : <Line colors={colors} tone={colors.foregroundMuted}>Nothing uncommitted; this step is skipped.</Line>}
      {plan.undoneCount ? <Line colors={colors} tone={colors.foregroundMuted}>Git also lists {plural(plan.undoneCount, "file")} as changed whose content matches {plan.taskBranch}; {plan.uncommittedCount ? "the commit brings the staging area in line" : "they are unstaged, and no file changes"}.</Line> : null}
    </View>
    <View style={{ gap: 4 }}>
      <Line colors={colors} strong>2. Push the task branch</Line>
      <Line colors={colors}>Push {plan.pushCommit ? plan.pushCommit.slice(0, 7) : "that commit"} to {plan.taskBranch} on origin ({plan.remote}): {plural(plan.commitsAhead + (plan.uncommittedCount ? 1 : 0), "commit")} that origin/{plan.targetBranch} lacks. Only this branch is pushed, and never forced: if origin's {plan.taskBranch} has commits this one lacks, nothing is pushed.</Line>
    </View>
    <View style={{ gap: 4 }}>
      <Line colors={colors} strong>3. Open a draft pull request</Line>
      <Line colors={colors}>On {forgeLabels[plan.forge]} ({plan.repository}), from {plan.taskBranch} into {plan.targetBranch}, as a draft{plan.workItem ? `, linked to work item ${plan.workItem}` : ""}.</Line>
      {plan.template ? <Line colors={colors} tone={colors.foregroundMuted}>{draft.state.phase === "written" && draft.state.text.body
        ? `The description keeps the sections of the repository's template, ${plan.template}.`
        : `The default description starts with the repository's template, ${plan.template}.`}</Line> : null}
      <DeliveryTextFields draft={draft} colors={colors} disabled={busy} only={["title", "body"]} />
    </View>
    <View style={{ gap: 4 }}>
      <Line colors={colors} strong>4. Afterwards</Line>
      <Line colors={colors}>• Record the pull request in the task, set the task to In review, and add a status.md line.</Line>
      <Line colors={colors}>• Attention lists the pull request. Once it merges there, Clean up archives the worktree workspace, deletes the local branch and marks the task delivered, only when you ask.</Line>
    </View>
    <View style={{ gap: 4 }}>
      <Line colors={colors} strong>Exact commands and request</Line>
      {edited ? <Line colors={colors} tone={colors.foregroundMuted}>Shown with Mission Control's default text. The run uses the text above; Dry run shows the commands with it.</Line> : null}
      <Commands commands={plan.commands} colors={colors} />
    </View>
    <Line colors={colors} tone={colors.foregroundMuted}>Nothing is merged, force-pushed or stored; credentials are never shown. The main checkout isn't touched. A slow run carries on in the background, and Attention keeps its result until you dismiss it.</Line>
  </View>;
}

export function PullRequestOutcome({ result, colors }: { result: PullRequestResult; colors: Colors }) {
  if (result.outcome === "refused") return <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 13 }}>Open PR refused: {result.reason}</Text>;
  if (result.outcome === "dry-run") {
    return <View style={{ gap: 6 }}>
      <Line colors={colors} strong>Dry run: these are exactly the commands and request a real run makes.</Line>
      {result.notes.map(note => <Line key={note} colors={colors} tone={colors.foregroundMuted}>{note}</Line>)}
      <Commands commands={result.commands} colors={colors} />
    </View>;
  }
  if (result.outcome === "failed") {
    return <View accessibilityRole="alert" style={{ gap: 6 }}>
      <Line colors={colors} tone={colors.statusWarning} strong>The pull request wasn't opened</Line>
      <Line colors={colors}>{result.reason}</Line>
      <StepLines steps={result.steps} colors={colors} />
    </View>;
  }
  return <View style={{ gap: 6 }}>
    <Line colors={colors} tone={colors.statusSuccess} strong>Opened draft pull request #{result.number} on {forgeLabels[result.forge]}.</Line>
    <CompactExternalLink colors={colors} label={(result.url)} href={result.url} accessibilityLabel={`Open pull request ${result.number}`} />
    <StepLines steps={result.steps} colors={colors} />
  </View>;
}

export function CleanupOutcome({ result, colors }: { result: CleanupResult; colors: Colors }) {
  if (result.outcome === "refused") return <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 13 }}>Clean up refused: {result.reason}</Text>;
  const problems = result.steps.filter(step => step.state !== "done").length;
  return <View style={{ gap: 6 }}>
    <Line colors={colors} tone={problems ? colors.statusWarning : colors.statusSuccess} strong>{problems ? `Cleaned up; ${plural(problems, "step")} need${problems === 1 ? "s" : ""} a look.` : "Cleaned up."}</Line>
    <StepLines steps={result.steps} colors={colors} />
  </View>;
}

/** The task a pull request dialog is about, with the plan frozen when the user pressed Open PR. */
export type PullRequestTarget = { taskId: string; plan: PullRequestPlan };

/** Attention's Open PR button for an approved task of a pull-request project; enabled only when every check passes. */
export function PullRequestButton({ serverId, taskId, taskTitle, online, colors, onOpen }: {
  serverId: string; taskId: string; taskTitle: string; online: boolean; colors: Colors; onOpen: (target: PullRequestTarget) => void;
}) {
  const check = useRpc(checkPullRequest);
  const [showChecks, setShowChecks] = useState(false);
  const status = useQuery({ queryKey: pullRequestCheckKey(serverId, taskId), queryFn: () => check({ serverId, taskId }), enabled: online, staleTime: 10_000, refetchInterval: online ? 30_000 : false, retry: false });
  const ready = online && status.data?.ready === true && status.data.plan !== null;
  const checks = status.data?.checks ?? [];
  const failing = checks.filter(item => !item.ok);
  const note = !online ? "Host offline."
    : status.isPending ? "Checking whether it can open a pull request…"
      : status.isError ? `Couldn't check: ${message(status.error)}`
        : failing.length ? `Can't open a pull request yet: ${failing[0].detail}${failing.length > 1 ? ` (+${failing.length - 1} more)` : ""}` : "All checks pass.";
  return <View style={{ gap: 4, flexShrink: 1 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open a draft pull request for ${taskTitle}`} accessibilityState={{ disabled: !ready }} disabled={!ready}
        onPress={() => { if (status.data?.plan) onOpen({ taskId, plan: status.data.plan }); }}
        style={{ minHeight: 36, paddingHorizontal: 12, justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: ready ? colors.accent : colors.border, backgroundColor: ready ? colors.accent : "transparent", opacity: ready ? 1 : 0.55 }}>
        <Text style={{ color: ready ? colors.accentForeground : colors.foreground, fontWeight: "600", fontSize: 12 }}>Open PR</Text>
      </Pressable>
      <Text numberOfLines={showChecks ? undefined : 2} style={{ color: status.isError ? colors.statusDanger : colors.foregroundMuted, fontSize: 11, flex: 1, minWidth: 140 }}>{note}</Text>
      {checks.length ? <CompactLink colors={colors} label={(showChecks ? "Hide checks" : "Checks")} accessibilityRole="button" accessibilityLabel={`Pull request checks for ${taskTitle}`} onPress={() => setShowChecks(!showChecks)} expanded={showChecks} /> : null}
    </View>
    {showChecks ? checks.map(item => <Text key={item.id} style={{ color: item.ok ? colors.foreground : colors.statusDanger, fontSize: 12, lineHeight: 17 }}>{item.ok ? "✓" : "✕"} {item.label}: {item.detail}</Text>) : null}
  </View>;
}

function DialogButton({ label, onPress, disabled, primary, colors, accessibilityLabel }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean; colors: Colors; accessibilityLabel?: string }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} disabled={disabled} onPress={onPress}
    style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: "center", borderRadius: 7, borderWidth: primary ? 1 : 0, borderColor: colors.accent, backgroundColor: primary ? colors.accent : "transparent", opacity: disabled ? 0.5 : 1 }}>
    <Text style={{ color: primary ? colors.accentForeground : colors.foreground, fontWeight: primary ? "600" : "400" }}>{label}</Text>
  </Pressable>;
}

/**
 * Open PR's confirmation and result dialog, rendered once by Attention. It shows exactly what will happen,
 * offers a dry run, then runs with the frozen plan (the server refuses if anything changed) and stays open with
 * the outcome until closed. A slow run carries on in the background; Attention keeps its card until dismissed.
 */
export function PullRequestDialog({ serverId, online, colors, target, onClose }: { serverId: string; online: boolean; colors: Colors; target: PullRequestTarget | null; onClose: () => void }) {
  const run = useRpc(runPullRequest);
  const queryClient = useQueryClient();
  const results = useDeliveryResults(serverId, online);
  const toast = useToast();
  const [result, setResult] = useState<PullRequestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"dry-run" | "open" | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const lock = useRef(false);
  const plan = target?.plan ?? null;
  // The commit message and the pull request's text: defaults, then what a small model writes from paseo.json, then the user's edits.
  const needs = { commit: (plan?.uncommittedCount ?? 0) > 0, pullRequest: plan !== null };
  const draft = useDeliveryText({
    serverId, taskId: target?.taskId ?? null, workspaceId: plan?.worktreeWorkspaceId ?? null, planKey: target ? `${target.taskId}:${target.plan.fingerprint}` : null,
    needs, defaults: plan ? defaultText(needs, plan) : {}, template: plan?.templateText ?? null,
  });
  const pending = pendingId ? results.data?.results.find(entry => entry.resultId === pendingId && entry.kind === "pull-request") ?? null : null;
  const shown = result ?? (pending?.kind === "pull-request" ? pending.result : null) ?? null;
  const failed = pending?.state === "failed" ? pending.error : null;
  const final = shown !== null && shown.outcome !== "dry-run";

  async function submit(dryRun: boolean) {
    if (!target || lock.current || draft.waiting || draft.problem) return;
    lock.current = true;
    setBusy(dryRun ? "dry-run" : "open");
    setError(null);
    try {
      const reply = await run({ serverId, taskId: target.taskId, fingerprint: target.plan.fingerprint, dryRun, ...draft.shown });
      if (reply.outcome === "running") setPendingId(reply.resultId);
      else {
        setResult(reply);
        if (reply.outcome === "opened") toast.show(`Opened draft pull request #${reply.number}`, { variant: "success" });
      }
    } catch (cause) { setError(message(cause)); }
    finally {
      lock.current = false;
      setBusy(null);
      if (!dryRun) refreshAfterDelivery(queryClient, serverId, target.taskId);
    }
  }

  const close = () => {
    if (lock.current) return;
    setResult(null); setError(null); setPendingId(null); onClose();
  };
  const blocked = busy !== null || !online || draft.waiting || draft.problem !== null;
  const title = shown ? (shown.outcome === "opened" ? "Draft pull request opened" : shown.outcome === "dry-run" ? "Dry run" : shown.outcome === "failed" ? "Pull request not opened" : "Open PR refused")
    : failed ? "Open PR stopped" : pendingId ? "Opening in the background" : "Open a draft pull request?";

  return <Modal colors={colors} title={title} open={target !== null} onOpenChange={open => { if (!open) close(); }}>
    <Modal.Content>
      <View style={{ gap: 12 }}>
        <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600" }}>{plan?.taskTitle}</Text>
        {shown ? <PullRequestOutcome result={shown} colors={colors} />
          : failed ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 13 }}>Open PR stopped with an error: {failed}</Text>
            : pendingId ? <Line colors={colors}>This is taking a while, so it carries on in the background{pending ? ` (${pending.step.toLowerCase()})` : ""}. You can close this; Attention shows its progress, then keeps its result until you dismiss it.</Line>
              : plan ? <PlanSteps plan={plan} draft={draft} busy={busy !== null} colors={colors} /> : null}
        {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 10 }}>
          <DialogButton label={final || failed || pendingId ? "Close" : "Cancel"} onPress={close} disabled={busy !== null} colors={colors} />
          {final || failed || pendingId ? null : <>
            {shown?.outcome === "dry-run" ? <DialogButton label="Back to the plan" onPress={() => setResult(null)} disabled={busy !== null} colors={colors} /> : null}
            <DialogButton label={busy === "dry-run" ? "Checking…" : "Dry run"} accessibilityLabel="Dry run: show the exact commands without changing anything" onPress={() => void submit(true)} disabled={blocked} colors={colors} />
            <DialogButton label={busy === "open" ? "Opening…" : draft.waiting ? "Writing…" : "Open draft PR"} accessibilityLabel="Confirm: commit, push and open the draft pull request" onPress={() => void submit(false)} disabled={blocked} primary colors={colors} />
          </>}
        </View>
      </View>
    </Modal.Content>
  </Modal>;
}

const stateLabels: Record<PullRequestState, string> = { draft: "Draft", open: "Open", merged: "PR merged", closed: "Closed without merging" };

function stateTone(state: PullRequestState | null, colors: Colors) {
  return state === "merged" ? colors.statusSuccess : state === "closed" ? colors.statusWarning : colors.foregroundMuted;
}

/** Attention's Pull requests list: this host's tasks with an open draft pull request, their state, and Clean up once merged. */
export function PullRequests({ serverId, hostLabel, online, colors, heading }: { serverId: string; hostLabel: string; online: boolean; colors: Colors; heading: (count: number | undefined) => ReactNode }) {
  const list = useRpc(listPullRequests);
  const queryClient = useQueryClient();
  // Read from each forge when Attention opens, on Refresh (which invalidates this) and on demand; never polled.
  const pullRequests = useQuery({ queryKey: pullRequestsKey(serverId), queryFn: () => list({ serverId, read: true }), enabled: online, staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false });
  const [reading, setReading] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState<TrackedPullRequest | null>(null);
  const items = pullRequests.data?.pullRequests ?? [];
  async function readOne(taskId: string) {
    setReading(taskId);
    try {
      const fresh = await list({ serverId, read: true, taskId });
      queryClient.setQueryData(pullRequestsKey(serverId), (current: { pullRequests: TrackedPullRequest[] } | undefined) => current
        ? { pullRequests: current.pullRequests.map(item => fresh.pullRequests.find(next => next.taskId === item.taskId) ?? item) } : fresh);
    } finally { setReading(null); }
  }
  if (online && pullRequests.data && !items.length) return null;
  return <View style={{ gap: 8 }}>
    {heading(pullRequests.data ? items.length : undefined)}
    {!online ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{hostLabel} is offline.</Text>
      : pullRequests.isPending ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Reading pull requests…</Text>
        : pullRequests.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>Pull requests unavailable: {message(pullRequests.error)}</Text> : null}
    {items.map(item => <View key={item.taskId} style={{ backgroundColor: colors.surface0, borderColor: colors.border, borderWidth: 1, borderLeftWidth: 3, borderLeftColor: stateTone(item.state, colors), borderRadius: 7, padding: 9, gap: 5 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>{item.title}</Text>
        <Text style={{ color: stateTone(item.state, colors), fontSize: 12, fontWeight: "600" }}>{item.state ? stateLabels[item.state] : item.error ? "Unknown" : "Not read yet"}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <CompactExternalLink colors={colors} label={["#",(item.number)," on ",(forgeLabels[item.forge])].join("")} href={item.url} accessibilityLabel={`Open pull request ${item.number}`} />
        <Text style={{ color: colors.foregroundMuted, fontSize: 11, flex: 1, minWidth: 160 }}>{item.taskBranch} → {item.targetBranch}{item.checkedAt ? ` · checked ${formatDateTime(item.checkedAt)}` : ""}</Text>
      </View>
      {item.error ? <Text style={{ color: colors.statusDanger, fontSize: 12 }}>Couldn't read its state: {item.error}</Text> : null}
      {item.state === "closed" ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Closed without merging, so there is nothing to clean up. The worktree and branch stay.</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
        <CompactLink colors={colors} label={(reading === item.taskId ? "Checking…" : "Check status")} accessibilityRole="button" accessibilityLabel={`Check the status of pull request ${item.number}`} disabled={!online || reading !== null} onPress={() => void readOne(item.taskId)} />
        {item.state === "merged" ? <Pressable accessibilityRole="button" accessibilityLabel={`Clean up after ${item.title}`} disabled={!online} onPress={() => setCleanup(item)}
          style={{ minHeight: 36, paddingHorizontal: 12, justifyContent: "center", borderRadius: 7, backgroundColor: colors.accent }}>
          <Text style={{ color: colors.accentForeground, fontWeight: "600", fontSize: 12 }}>Clean up…</Text>
        </Pressable> : null}
      </View>
    </View>)}
    <CleanupDialog serverId={serverId} online={online} colors={colors} target={cleanup} onClose={() => setCleanup(null)} />
  </View>;
}

/** Clean up's confirmation: what it will do, read fresh from the server, then its result. */
export function CleanupDialog({ serverId, online, colors, target, onClose }: { serverId: string; online: boolean; colors: Colors; target: TrackedPullRequest | null; onClose: () => void }) {
  const plan = useRpc(planCleanup);
  const run = useRpc(runCleanup);
  const queryClient = useQueryClient();
  const preview = useQuery({ queryKey: ["mission-control", "cleanup-plan", serverId, target?.taskId], queryFn: () => plan({ serverId, taskId: target!.taskId }), enabled: online && target !== null, staleTime: 0, gcTime: 0, retry: false });
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  async function confirm() {
    if (!target || lock.current) return;
    lock.current = true;
    setRunning(true);
    setError(null);
    try {
      const reply = await run({ serverId, taskId: target.taskId });
      if (reply.outcome === "running") setError("Clean up is taking a while and carries on in the background; Attention shows its result.");
      else setResult(reply);
    } catch (cause) { setError(message(cause)); }
    finally { lock.current = false; setRunning(false); refreshAfterDelivery(queryClient, serverId, target.taskId); }
  }
  const close = () => { if (lock.current) return; setResult(null); setError(null); onClose(); };
  const ready = preview.data?.plan ?? null;
  return <Modal colors={colors} title={result ? "Clean up" : "Clean up after the merged pull request?"} open={target !== null} onOpenChange={open => { if (!open) close(); }}>
    <Modal.Content>
      <View style={{ gap: 12 }}>
        <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600" }}>{target?.title}</Text>
        {result ? <CleanupOutcome result={result} colors={colors} />
          : preview.isPending ? <Line colors={colors} tone={colors.foregroundMuted}>Reading the pull request's state…</Line>
            : preview.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 13 }}>{message(preview.error)}</Text>
              : !ready ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 13 }}>{preview.data?.reason}</Text>
                : <View style={{ gap: 4 }}>
                  <Line colors={colors}>The pull request merged. Clean up will:</Line>
                  <Line colors={colors}>• Clear the worktree workspace's Review marks.</Line>
                  <Line colors={colors}>• Archive the worktree workspace in Paseo. This closes its agents and terminals and may remove the worktree folder.</Line>
                  <Line colors={colors}>• {ready.branchDeletable ? `Delete the local branch ${ready.taskBranch}.` : `Keep the local branch: ${ready.branchNote}`}</Line>
                  <Line colors={colors}>• Set the task to delivered and add a status.md line.</Line>
                  <Line colors={colors} tone={colors.foregroundMuted}>origin's branch and the pull request are left to the forge. The pull request's state is read again first.</Line>
                </View>}
        {error ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning, fontSize: 13 }}>{error}</Text> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 10 }}>
          <DialogButton label={result ? "Close" : "Cancel"} onPress={close} disabled={running} colors={colors} />
          {result || !ready ? null : <DialogButton label={running ? "Cleaning up…" : "Clean up"} onPress={() => void confirm()} disabled={running || !online} primary colors={colors} />}
        </View>
      </View>
    </Modal.Content>
  </Modal>;
}
