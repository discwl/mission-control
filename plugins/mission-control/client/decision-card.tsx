import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { decisionsKey, resolveDecision, type DecisionEntry, type Finding } from "../shared/decisions";
import { answerFor, decisionCardModel, fixIds, initialChoices, openFindings, shownNote, type Answer, type ButtonId, type Choice, type Choices, type NoteState } from "./decision-card-model";
import { formatDateTime } from "./date-time";
import { answerProblem } from "./decision-note";
import { decisionNeed, decisionWhere, latestAgentQuote, mayReadChat } from "./attention-model";
import { CardFooter, NeedLine, TaskHeader, useTimeline, WhereLine } from "./attention-card";

type Colors = PluginSurfaceProps["theme"]["colors"];
type Place = { hostLabel: string; projectName: string; workspaceName: string } | null;
export type DecisionActions = {
  describe: (workspaceId: string) => Place;
  openAgent: (agentId: string) => void;
  // Omitted where Mission Control's Docs tab is not reachable, such as the Mission panel.
  openDocs?: (workspaceId: string, taskId: string) => void;
  // The agent's roster state, so an older decision quotes the chat only for a live agent (see mayReadChat).
  // Without it the chat is read only when the user opens Conversation.
  agentOf?: (agentId: string) => { status: string; archivedAt: string | null; attentionReason?: string | null } | null;
};
type Outcome = "approved" | "changes_requested" | "blocked";

export const outcomeLabel = { approved: "Approved", changes_requested: "Changes requested", blocked: "Blocked", open: "Open" } as const;

function severityColor(severity: Finding["severity"], colors: Colors) {
  return severity === "high" ? colors.statusDanger : severity === "medium" ? colors.statusWarning : colors.foregroundMuted;
}

function ActionButton({ label, onPress, disabled, tone, colors }: { label: string; onPress: () => void; disabled: boolean; tone: "primary" | "plain" | "danger"; colors: Colors }) {
  const color = tone === "danger" ? colors.statusDanger : tone === "primary" ? colors.accentForeground : colors.foreground;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
    style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: "center", borderRadius: 7, borderWidth: 1, opacity: disabled ? 0.5 : 1,
      borderColor: tone === "danger" ? colors.statusDanger : tone === "primary" ? colors.accent : colors.border,
      backgroundColor: tone === "primary" ? colors.accent : "transparent" }}>
    <Text style={{ color, fontWeight: "600", fontSize: 13 }}>{label}</Text>
  </Pressable>;
}

function Heading({ children, colors }: { children: ReactNode; colors: Colors }) {
  return <Text accessibilityRole="header" style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: "700", marginTop: 4 }}>{children}</Text>;
}

function Link({ label, onPress, colors, expanded }: { label: string; onPress: () => void; colors: Colors; expanded?: boolean }) {
  return <CompactLink label={label} onPress={onPress} colors={colors} expanded={expanded} />;
}

/** A Fix now / Skip pair for one finding. */
function ChoiceToggle({ value, onChange, disabled, label, colors }: { value: Choice; onChange: (choice: Choice) => void; disabled: boolean; label: string; colors: Colors }) {
  return <View accessibilityRole="radiogroup" accessibilityLabel={`What to do about: ${label}`} style={{ flexDirection: "row", borderWidth: 1, borderColor: colors.border, borderRadius: 7, overflow: "hidden", alignSelf: "flex-start" }}>
    {(["fix", "skip"] as const).map(choice => {
      const selected = value === choice;
      return <Pressable key={choice} accessibilityRole="radio" accessibilityState={{ selected, disabled }} accessibilityLabel={choice === "fix" ? "Fix now" : "Skip"} disabled={disabled} onPress={() => onChange(choice)}
        style={{ minHeight: 36, paddingHorizontal: 12, justifyContent: "center", backgroundColor: selected ? colors.accent : "transparent" }}>
        <Text style={{ color: selected ? colors.accentForeground : colors.foreground, fontSize: 12, fontWeight: selected ? "700" : "400" }}>{choice === "fix" ? "Fix now" : "Skip"}</Text>
      </Pressable>;
    })}
  </View>;
}

/**
 * One open plan or review decision, in plain language for a busy product owner. Collapsed: the kind,
 * the task, what was done and found, the recommendation and the answers. More: what was built, each
 * finding with its own Fix now / Skip choice, what each button does, the note, and the technical details.
 * `brief` only tightens the spacing, for Attention's compact list.
 */
export function DecisionCard({ entry, serverId, hostLabel, colors, actions, brief = false, inChat = false }: { entry: DecisionEntry; serverId: string; hostLabel: string; colors: Colors; actions: DecisionActions; brief?: boolean; inChat?: boolean }) {
  const { decision } = entry;
  const place = actions.describe(decision.workspaceId);
  const review = decision.kind === "review";
  const open = openFindings(entry).length;
  const [choices, setChoices] = useState<Choices>(() => initialChoices(entry.findings));
  const [note, setNote] = useState<NoteState>({ text: "", edited: false });
  // Stop, Change the plan, and any answer whose note isn't on screen show the exact note before sending.
  const [confirm, setConfirm] = useState<(Answer & { id: ButtonId }) | null>(null);
  const [more, setMore] = useState(false);
  const [technical, setTechnical] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = useRpc(resolveDecision);
  const queryClient = useQueryClient();
  const toast = useToast();
  const model = decisionCardModel(entry, choices);
  // Older decisions without the agent's plain summary quote its chat instead.
  const timeline = useTimeline(serverId, decision.agentId, !decision.plain && Boolean(decision.agentId) && mayReadChat(actions.agentOf?.(decision.agentId!)), decision.decisionId);
  const summary = decisionWhere(entry, latestAgentQuote(timeline.data), `${model.lines.built}${model.lines.found && review ? ` ${model.lines.found}` : ""}`);
  const toFix = fixIds(entry, choices);

  async function submit(outcome: Outcome, text: string) {
    // Say what's missing up front, and open More where it can be added.
    const missing = answerProblem({ kind: decision.kind, outcome, openFindings: open, selected: toFix.length, note: text });
    if (missing) { if (!confirm) setMore(true); setError(missing); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await resolve({
        serverId, workspaceId: decision.workspaceId, taskId: decision.taskId, runId: decision.runId, decisionId: decision.decisionId,
        expectedRevision: entry.revision, outcome, note: text, submitFindingIds: outcome === "changes_requested" ? toFix : [],
      });
      const delivered = result.decision.resume?.phase === "sent";
      toast.show(delivered ? `${outcomeLabel[outcome]} · sent to the agent` : `${outcomeLabel[outcome]} · saved, not sent yet`, { variant: delivered ? "success" : "warning" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      void queryClient.invalidateQueries({ queryKey: decisionsKey(serverId) });
      setBusy(false);
    }
  }

  function press(id: ButtonId) {
    setError(null);
    const answer = answerFor(entry, choices, id, note, more);
    if (answer.confirm) setConfirm({ ...answer, id });
    else void submit(answer.outcome, answer.note);
  }

  const where = `${hostLabel} / ${place?.projectName ?? entry.projectId} / ${place?.workspaceName ?? decision.workspaceId}`;
  const recommended = model.recommendation ? `${model.recommendation.label}. ${model.recommendation.reason}` : null;
  const muted = { color: colors.foregroundMuted, fontSize: 12 } as const;
  const body = { color: colors.foreground, fontSize: 13, lineHeight: 19 } as const;

  return <View accessibilityLabel={`${review ? "Review" : "Plan"} decision for ${entry.taskTitle}`} style={{ borderColor: colors.accent, borderWidth: 1, borderLeftWidth: brief ? 3 : 4, borderRadius: 8, padding: brief ? 9 : 11, gap: brief ? 5 : 7, backgroundColor: colors.surface1 }}>
    <TaskHeader badge={model.kind} badgeColor={colors.accent} task={{ title: model.title, place: where }} expanded={more} colors={colors} />

    {more ? null : <>
      <WhereLine where={summary} colors={colors} />
      {summary.source === "generic" ? <Text style={muted}>Open More for the details.</Text> : null}
    </>}
    <NeedLine need={decisionNeed(entry)} recommendation={recommended} colors={colors} />
    {model.unverified ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{model.unverified}</Text> : null}

    {more ? <View style={{ gap: 6 }}>
      <Heading colors={colors}>{model.more.builtHeading.toUpperCase()}</Heading>
      <Text style={body}>{model.more.built}</Text>
      {review ? <>
        <Heading colors={colors}>WHAT THE REVIEW FOUND</Heading>
        {model.more.found ? <Text style={body}>{model.more.found}</Text> : null}
        {model.more.fixed.map((text, index) => <Text key={`fixed-${index}`} style={body}><Text style={{ color: colors.statusSuccess, fontWeight: "700" }}>✓ </Text>Fixed: {text}</Text>)}
        {model.more.findings.map(finding => <View key={finding.findingId} style={{ gap: 4, paddingVertical: 4, borderTopWidth: 1, borderTopColor: colors.border }}>
          <Text style={body}><Text style={{ color: severityColor(finding.severity, colors), fontWeight: "700" }}>{finding.severityLabel}: </Text>{finding.text}</Text>
          {finding.impact ? <Text style={muted}>If skipped: {finding.impact}</Text> : null}
          <ChoiceToggle value={finding.choice} label={finding.text} disabled={busy || confirm !== null} colors={colors}
            onChange={choice => setChoices(current => ({ ...current, [finding.findingId]: choice }))} />
        </View>)}
      </> : null}
      <Heading colors={colors}>WHAT EACH BUTTON DOES</Heading>
      {model.more.help.map(item => <Text key={item.label} style={body}><Text style={{ fontWeight: "700" }}>{item.label}: </Text>{item.text}</Text>)}
      <TextInput accessibilityLabel="Note for the agent" placeholder="Note for the agent (optional)" placeholderTextColor={colors.foregroundMuted}
        value={shownNote(decision.kind, open, toFix.length, note)} onChangeText={text => setNote({ text, edited: true })} editable={!busy} multiline
        style={{ color: colors.foreground, backgroundColor: colors.surface0, borderColor: colors.border, borderWidth: 1, borderRadius: 7, padding: 9, minHeight: 52, fontSize: 13, textAlignVertical: "top" }} />
    </View> : null}

    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
    {confirm ? <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 6 }}>
      <Text style={body}>{confirm.prompt}</Text>
      <TextInput accessibilityLabel={`Note sent with ${confirm.sendLabel}`} value={confirm.note} autoFocus editable={!busy} multiline
        onChangeText={text => setConfirm({ ...confirm, note: text })} placeholder={confirm.id === "change" ? "Describe the changes you want" : "Note for the agent"} placeholderTextColor={colors.foregroundMuted}
        style={{ color: colors.foreground, backgroundColor: colors.surface0, borderColor: colors.border, borderWidth: 1, borderRadius: 7, padding: 9, minHeight: 52, fontSize: 13, textAlignVertical: "top" }} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <ActionButton label={confirm.sendLabel} tone={confirm.id === "stop" ? "danger" : "primary"} disabled={busy || (confirm.noteRequired && !confirm.note.trim())}
          onPress={() => void submit(confirm.outcome, confirm.note)} colors={colors} />
        <ActionButton label="Cancel" tone="plain" disabled={busy} onPress={() => { setConfirm(null); setError(null); }} colors={colors} />
      </View>
    </View> : <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      {model.buttons.map(button => <ActionButton key={button.id} label={button.label} disabled={busy} onPress={() => press(button.id)} colors={colors}
        tone={button.id === "stop" ? "danger" : button.primary ? "primary" : "plain"} />)}
      <Link label={more ? "Less" : "More"} expanded={more} onPress={() => setMore(!more)} colors={colors} />
    </View>}

    {more ? <View style={{ gap: 4 }}>
      <Link label={technical ? "Hide technical details" : "Technical details"} expanded={technical} onPress={() => setTechnical(!technical)} colors={colors} />
      {technical ? <View style={{ gap: 6 }}>
        <Text style={muted}>{where} · asked {formatDateTime(decision.requestedAt)}</Text>
        <Text style={{ ...body, fontWeight: "600" }}>{model.technical.question}</Text>
        <Text style={body}>{model.technical.summary}</Text>
        {model.technical.evidence.length ? <View style={{ gap: 2 }}>
          <Heading colors={colors}>EVIDENCE</Heading>
          {model.technical.evidence.map(item => <Text key={item} style={muted}>• {item}</Text>)}
        </View> : null}
        {decision.gitDirty ? <Text style={{ ...muted, fontSize: 11 }}>Requested with uncommitted changes{decision.gitHead ? ` on ${decision.gitHead.slice(0, 8)}` : " (no commits yet)"}.</Text> : null}
        {model.technical.findings.length ? <View style={{ gap: 4 }}>
          <Heading colors={colors}>FINDINGS</Heading>
          {model.technical.findings.map(finding => <View key={finding.findingId} style={{ gap: 2 }}>
            <Text style={{ color: colors.foreground, fontSize: 12 }}><Text style={{ color: severityColor(finding.severity, colors), fontWeight: "700" }}>{finding.severity.toUpperCase()} </Text>{finding.title}</Text>
            {finding.file ? <Text style={{ ...muted, fontSize: 11 }}>{finding.file}</Text> : null}
            {finding.detail ? <Text style={muted}>{finding.detail}</Text> : null}
          </View>)}
        </View> : null}
      </View> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
        {actions.openDocs ? <Link label="View task docs →" onPress={() => actions.openDocs?.(decision.workspaceId, decision.taskId)} colors={colors} /> : null}
      </View>
    </View> : null}
    {inChat ? null : <CardFooter serverId={serverId} agentId={decision.agentId} version={decision.decisionId} openAgent={decision.agentId ? () => actions.openAgent(decision.agentId!) : null} colors={colors} />}
  </View>;
}
import { CompactLink } from "./compact-link";
