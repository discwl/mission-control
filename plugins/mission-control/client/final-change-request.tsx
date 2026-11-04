import { useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { z } from "zod";
import { useRpc } from "./host-rpc";
import { readPipelineEvidence, type PipelineInspection } from "../shared/pipeline";
import { finalReviewChanges } from "../shared/delivery-feedback";
import type { ActionDeliveryPlan } from "../shared/action-delivery";
import { useReviewComments } from "./review-comments";
import { CompactLink } from "./compact-link";

type Request = z.input<typeof finalReviewChanges.input>;
export function FinalChangeRequest({ serverId, workspaceId, taskId, runId, stale, reviewFingerprint, artifact, colors, onSaved }: {
  serverId: string; workspaceId: string; taskId: string; runId: string; stale: boolean; reviewFingerprint?: string;
  artifact?: Pick<ActionDeliveryPlan, "taskId" | "runId" | "workspaceId" | "revision" | "planRevision">;
  colors: PluginSurfaceProps["theme"]["colors"]; onSaved(): void;
}) {
  const read = useRpc(readPipelineEvidence); const save = useRpc(finalReviewChanges);
  const comments = useReviewComments(serverId, workspaceId, true);
  const [open, setOpen] = useState(false); const [note, setNote] = useState("");
  const [facts, setFacts] = useState<PipelineInspection | null>(null);
  const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(false); const [message, setMessage] = useState("");
  const request = useRef<Request | null>(null); const sending = useRef(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setFacts(null); setMessage("");
    void read({ serverId, workspaceId, taskId }).then(value => { if (active) setFacts(value); }).catch(error => { if (active) setMessage(`The current checks could not be loaded. Refresh this task before requesting fixes. ${String(error.message ?? error)}`); });
    return () => { active = false; };
  }, [open, serverId, workspaceId, taskId, read]);
  const matches = facts?.entry.run?.runId === runId && facts?.entry.task.taskId === taskId && facts?.entry.run?.workspaceId === workspaceId && facts?.entry.run?.serverId === serverId;
  const artifactMatches = !artifact || (artifact.taskId === taskId && artifact.runId === runId && artifact.workspaceId === workspaceId && artifact.revision === facts?.candidate?.tree && artifact.planRevision === facts?.planRevision);
  const canSave = !stale && artifactMatches && matches && facts?.workflowMode === "automatic" && !!facts.candidate && !!facts.planRevision && note.trim().length > 0 && note.trim().length <= 8000 && !saved;
  async function submit() {
    if (sending.current || saved || (!request.current && !canSave)) return;
    if (!request.current) request.current = { requestId: globalThis.crypto.randomUUID(), serverId, workspaceId, taskId, runId, expectedCandidate: artifact ? { head: null, tree: artifact.revision } : facts!.candidate!, expectedPlanRevision: artifact?.planRevision ?? facts!.planRevision!, note: note.trim(), actorId: "human-ui", ...(reviewFingerprint ? { expectedReviewFingerprint: reviewFingerprint } : {}) };
    sending.current = true; setBusy(true); setMessage("");
    try {
      await save(request.current);
      setSaved(true); setMessage("Your requested fixes are saved. The final action is blocked. The task will return to the builder, then run validation and both reviews again. If its repair limit has been reached, it will ask for your attention."); onSaved();
    } catch (error) {
      setMessage(`The request could not be confirmed. Refresh the task to check its status, or retry this same request safely. ${String(error instanceof Error ? error.message : error)}`);
    } finally { sending.current = false; setBusy(false); }
  }
  const openComments = comments.comments.filter(comment => comment.status === "open");
  return <View style={{ gap: 10 }}>
    <CompactLink label={open ? "Hide requested fixes" : "Request fixes before continuing"} colors={colors} expanded={open} onPress={() => setOpen(!open)} />
    {open ? <>
      <Text style={{ color: colors.foreground, lineHeight: 22 }}>Describe what needs to change. This sends the task back for fixes and pauses the final action. Saving a code comment by itself does not request a repair.</Text>
      {!facts && !message ? <Text style={{ color: colors.foregroundMuted }}>Checking the version you are reviewing…</Text> : null}
      {!artifactMatches && facts ? <Text style={{ color: colors.statusWarning }}>The prepared actions changed after this preview opened. Refresh the action preview before requesting fixes.</Text> : null}
      {stale ? <Text style={{ color: colors.statusWarning }}>The displayed code is out of date. Refresh it before requesting fixes.</Text> : null}
      <TextInput accessibilityLabel="What should change before continuing?" multiline value={note} editable={!busy && !request.current && !saved} onChangeText={setNote} placeholder="Explain the problem, the expected result and any file or line involved." placeholderTextColor={colors.foregroundMuted} style={{ minHeight: 110, padding: 12, borderColor: colors.border, borderWidth: 1, borderRadius: 6, color: colors.foreground, backgroundColor: colors.surface1 }} />
      {openComments.length ? <CompactLink label={`Use ${openComments.length} open workspace comment${openComments.length === 1 ? "" : "s"}`} colors={colors} disabled={busy || !!request.current || saved} onPress={() => setNote(openComments.map(comment => `${comment.path}: ${comment.body}`).join("\n\n"))} /> : null}
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Check the wording before sending, especially when other tasks share this workspace.</Text>
      <CompactLink label={busy ? "Saving requested fixes…" : saved ? "Fixes requested" : request.current ? "Retry the same request" : "Request these fixes"} colors={colors} disabled={busy || saved || (!request.current && !canSave)} onPress={() => void submit()} />
      {message ? <Text accessibilityRole="alert" style={{ color: saved ? colors.foreground : colors.statusWarning, lineHeight: 22 }}>{message}</Text> : null}
    </> : null}
  </View>;
}
