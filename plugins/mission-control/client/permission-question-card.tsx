import { getPaseoClient, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { CardFooter, TaskHeader, WhereLine } from "./attention-card";
import type { TaskLine } from "./attention-model";
import type { PermissionRequest } from "./permission-detail";
import {
  dismissQuestionResponse, emptyAnswer, nativeQuestions, questionAnswered, questionResponse,
  respondToNativeQuestion, selectCustomAnswer, selectQuestionOption, writeQuestionAnswer,
  type QuestionAnswer, type QuestionDraft,
} from "./permission-questions";

type Colors = PluginSurfaceProps["theme"]["colors"];
type Props = {
  serverId: string; agentId: string; agentName: string; request: PermissionRequest; colors: Colors;
  place?: string | null; task?: TaskLine; openAgent?: () => void; compact?: boolean; brief?: boolean; latest?: string | null;
};

/** One native question at a time. The parent keys this form by host, agent and request content. */
export function PermissionQuestionCard({ serverId, agentId, agentName, request, colors, place, task, openAgent, compact, brief, latest }: Props) {
  const queryClient = useQueryClient();
  const questions = nativeQuestions(request);
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<QuestionDraft>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const question = questions?.[page];
  const answer = draft[page] ?? emptyAnswer();
  const disabled = busy || Boolean(sent);
  const last = Boolean(questions && page === questions.length - 1);
  const ready = question && questionAnswered(question, answer) && (!last || questions!.every((item, index) => questionAnswered(item, draft[index])));

  function update(next: QuestionAnswer) {
    if (disabled) return;
    setDraft(current => ({ ...current, [page]: next }));
    setError(null);
  }

  async function submit(dismiss = false) {
    if (!questions || sending.current || sent) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = dismiss ? dismissQuestionResponse(request, questions) : questionResponse(request, questions, draft);
      await respondToNativeQuestion(getPaseoClient(serverId), serverId, agentId, request, response);
      if (mounted.current) setSent(dismiss ? "Questions dismissed." : "Answers sent.");
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ["mission-control"] });
    }
  }

  function choice(label: string, description: string | undefined, checked: boolean, onPress: () => void, key: string) {
    return <Pressable key={key} accessibilityRole={question?.multiSelect ? "checkbox" : "radio"}
      accessibilityLabel={label} accessibilityHint={description} accessibilityState={{ checked, disabled }} disabled={disabled} onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 9, minHeight: 44, padding: 10, borderRadius: 7, borderWidth: 1,
        borderColor: checked ? colors.accent : colors.border, backgroundColor: checked ? colors.surface2 : colors.surface1, opacity: disabled ? 0.55 : 1 }}>
      <View accessible={false} style={{ width: 18, height: 18, borderRadius: question?.multiSelect ? 4 : 9, borderWidth: 1.5,
        borderColor: checked ? colors.accent : colors.foregroundMuted, backgroundColor: checked ? colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
        {checked ? question?.multiSelect ? <Text style={{ color: colors.accentForeground, fontSize: 12, fontWeight: "700" }}>✓</Text>
          : <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accentForeground }} /> : null}
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>{label}</Text>
        {description ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{description}</Text> : null}
      </View>
    </Pressable>;
  }

  function button(label: string, onPress: () => void, primary = false, unavailable = false) {
    const inactive = disabled || unavailable;
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: inactive }} disabled={inactive} onPress={onPress}
      style={{ minHeight: 40, paddingHorizontal: 12, justifyContent: "center", borderRadius: 7, borderWidth: 1, opacity: inactive ? 0.5 : 1,
        borderColor: primary ? colors.accent : colors.border, backgroundColor: primary ? colors.accent : "transparent" }}>
      <Text style={{ color: primary ? colors.accentForeground : colors.foreground, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </Pressable>;
  }

  return <View accessibilityLabel={`Questions from ${task?.title ?? agentName}`} style={{ borderColor: colors.statusWarning, borderWidth: 1, borderLeftWidth: brief ? 3 : 4,
    borderRadius: 8, padding: compact || brief ? 9 : 11, gap: 9, backgroundColor: colors.surface1 }}>
    {brief ? <>
      <TaskHeader badge="QUESTION" badgeColor={colors.statusWarning} task={task ?? { title: agentName, place: place ?? "" }} colors={colors} />
      {latest ? <WhereLine where={{ text: latest, source: "chat" }} colors={colors} /> : null}
    </> : <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ color: colors.statusWarning, fontSize: 11, fontWeight: "700" }}>QUESTION</Text>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: 13, fontWeight: "600" }}>{agentName}</Text>
      </View>
      {place ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{place}</Text> : null}
    </>}
    {!questions || !question ? <>
      <Text style={{ color: colors.foreground, fontSize: 13 }}>This question format isn't supported here. Open the agent to answer it.</Text>
      {openAgent ? button("Open agent", openAgent) : null}
    </> : <>
      <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 11 }}>Question {page + 1} of {questions.length} · {question.header}</Text>
      <View key={page} style={{ gap: 7 }}>
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>{question.question}</Text>
        {question.options.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{question.multiSelect ? "Choose one or more." : "Choose one."}{question.allowOther ? " You can also write your own answer." : ""}</Text> : null}
        <View accessibilityRole={question.multiSelect ? undefined : "radiogroup"} accessibilityLabel={question.question} style={{ gap: 6 }}>
          {question.options.map((option, index) => choice(option.label, option.description, answer.selected.includes(index), () => update(selectQuestionOption(question, answer, index)), `option-${index}`))}
          {question.options.length > 0 && question.allowOther ? choice("Write my own answer", undefined, answer.custom, () => update(selectCustomAnswer(question, answer)), "custom") : null}
        </View>
        {question.options.length === 0 || (question.allowOther && answer.custom) ? <TextInput multiline editable={!disabled}
          accessibilityLabel={`Your answer: ${question.question}`} placeholder={question.placeholder ?? "Type your answer…"} placeholderTextColor={colors.foregroundMuted}
          value={answer.text} onChangeText={text => update(writeQuestionAnswer(question, answer, text))}
          style={{ minHeight: 76, maxHeight: 180, padding: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 7, color: colors.foreground, backgroundColor: colors.surface2, fontSize: 13, textAlignVertical: "top" }} /> : null}
        {question.allowEmpty ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>A written answer may be left blank.</Text> : null}
      </View>
      {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
      {sent ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foreground, fontSize: 12 }}>{sent}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        {page > 0 ? button("Back", () => setPage(page - 1)) : null}
        {last ? button(busy ? "Sending…" : questions.length > 1 ? "Submit answers" : "Submit answer", () => void submit(), true, !ready)
          : button("Next", () => { if (ready) setPage(page + 1); }, true, !ready)}
        {button(questions[0].dismissLabel ?? "Dismiss", () => void submit(true))}
      </View>
    </>}
    {brief ? <CardFooter serverId={serverId} agentId={agentId} version={request.id} openAgent={openAgent} colors={colors} /> : null}
  </View>;
}
