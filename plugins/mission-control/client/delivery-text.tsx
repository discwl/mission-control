import { getPaseoClient, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { getDeliveryInstructions, maxBodyChars, maxCommitMessageChars, maxTitleChars, writeDeliveryText } from "../shared/paseo-metadata";
import { draftNote, fieldLabels, isWaiting, shownText, stateAfterReading, textProblem, textRequest, type DraftState, type TextField, type TextNeeds, type TextValues } from "./delivery-text-model";

type Colors = PluginSurfaceProps["theme"]["colors"];

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/**
 * The confirmation's commit and pull request text for one frozen plan (`planKey` changes with each). It shows the
 * defaults at once, reads paseo.json, and fills in what the model writes unless the user already edited a field.
 */
export function useDeliveryText({ serverId, taskId, workspaceId, planKey, needs, defaults, template = null }: {
  serverId: string; taskId: string | null; workspaceId: string | null; planKey: string | null; needs: TextNeeds; defaults: TextValues;
  // The repository's pull request template from Open PR's plan; the model keeps its sections.
  template?: string | null;
}) {
  const read = useRpc(getDeliveryInstructions);
  const [state, setState] = useState<DraftState>({ phase: "reading" });
  const [edits, setEdits] = useState<TextValues>({});
  // Each plan's attempt; an answer for an earlier plan, or after Use the default, is ignored.
  const attempt = useRef(0);

  useEffect(() => {
    const current = ++attempt.current;
    setEdits({});
    if (!planKey || !taskId || !workspaceId || !(needs.commit || needs.pullRequest)) { setState({ phase: "skipped" }); return; }
    setState({ phase: "reading" });
    const live = () => attempt.current === current;
    void (async () => {
      let info;
      try { info = await read({ serverId, taskId }); }
      catch (cause) { if (live()) setState({ phase: "defaults", reason: `Couldn't read the repository's paseo.json: ${message(cause)} This is Mission Control's default text.` }); return; }
      if (!live()) return;
      const next = stateAfterReading(info, needs);
      setState(next);
      const request = textRequest(info, needs, template);
      if (next.phase !== "writing" || !request) return;
      try {
        const written = await writeDeliveryText(getPaseoClient(serverId), workspaceId, request, { taskId, ticket: info.ticket });
        if (live()) setState({ phase: "written", path: next.path, model: written.model, text: written.text });
      } catch (cause) { if (live()) setState({ phase: "failed", path: next.path, error: message(cause) }); }
    })();
    // The template comes from the plan, which planKey identifies.
  }, [planKey, serverId, taskId, workspaceId, needs.commit, needs.pullRequest]);

  const shown = shownText(defaults, state, edits);
  return {
    state, shown,
    note: draftNote(state, defaults),
    waiting: isWaiting(state),
    problem: textProblem(shown),
    edit: (field: TextField, text: string) => setEdits(current => ({ ...current, [field]: text })),
    useDefaults: () => { attempt.current++; setState({ phase: "skipped" }); },
  };
}
export type DeliveryTextDraft = ReturnType<typeof useDeliveryText>;

const limits: Record<TextField, number> = { commitMessage: maxCommitMessageChars, title: maxTitleChars, body: maxBodyChars };

/** The editable commit message and pull request text (`only` picks some), with where they came from unless `quiet`. */
export function DeliveryTextFields({ draft, colors, disabled, only, quiet = false }: { draft: DeliveryTextDraft; colors: Colors; disabled: boolean; only?: TextField[]; quiet?: boolean }) {
  const fields = (Object.keys(draft.shown) as TextField[]).filter(field => !only || only.includes(field));
  if (!fields.length) return null;
  const inputStyle = { color: colors.foreground, borderColor: colors.border, borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, minHeight: 44, backgroundColor: colors.surface1, fontSize: 13 } as const;
  return <View style={{ gap: 8 }}>
    {fields.map(field => <View key={field} style={{ gap: 4 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{fieldLabels[field]}</Text>
      <TextInput accessibilityLabel={fieldLabels[field]} value={draft.shown[field]} editable={!disabled} maxLength={limits[field]}
        multiline={field !== "title"} onChangeText={text => draft.edit(field, text)}
        style={[inputStyle, field === "title" ? null : { minHeight: field === "body" ? 140 : 72, maxHeight: 260, textAlignVertical: "top", fontFamily: "monospace", fontSize: 12 }]} />
    </View>)}
    {quiet ? null : <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
      <Text style={{ color: draft.state.phase === "failed" ? colors.statusWarning : colors.foregroundMuted, fontSize: 12, flex: 1, minWidth: 180 }}>{draft.note}</Text>
      {draft.waiting ? <CompactLink label="Use the default" accessibilityLabel="Stop waiting and use Mission Control's default text" colors={colors} onPress={draft.useDefaults} /> : null}
    </View>}
    {draft.problem && !draft.waiting && !quiet ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{draft.problem}</Text> : null}
  </View>;
}
import { CompactLink } from "./compact-link";
