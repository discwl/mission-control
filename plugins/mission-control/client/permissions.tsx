import { CompactLink } from "./compact-link";
import { PermissionQuestionCard } from "./permission-question-card";
import { questionRequestVersion } from "./permission-questions";
import { getPaseoClient, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { permissionChoices, permissionDetail, type PermissionChoice, type PermissionRequest } from "./permission-detail";
import { latestAgentQuote, permissionCard, type TaskLine } from "./attention-model";
import { CardFooter, NeedLine, TaskHeader, useTimeline, WhereLine } from "./attention-card";

export type { PermissionRequest } from "./permission-detail";
type Colors = PluginSurfaceProps["theme"]["colors"];

/**
 * One pending permission prompt with the same choices the agent's chat offers.
 * Answers go straight to the agent through Paseo; nothing is stored by Mission Control.
 * `brief` is Attention's Needs you layout: the task line, where it's at (the agent's latest message),
 * what it wants to do, the choices, and Details, Conversation and Open agent behind small links.
 */
export function PermissionCard({ serverId, agentId, agentName, place, task, openAgent, request, colors, compact, brief = false, readChat = false }: {
  serverId: string; agentId: string; agentName: string; place?: string | null; task?: TaskLine; openAgent?: () => void; request: PermissionRequest; colors: Colors; compact?: boolean; brief?: boolean;
  // Whether the chat may be read without being asked (see mayReadChat); reading a stopped agent's chat wakes it.
  readChat?: boolean;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  // Attention quotes the chat for where it's at; the request's ID reads it again for each new prompt.
  const timeline = useTimeline(serverId, agentId, brief && readChat, request.id);
  const detail = permissionDetail(request);
  const described = Boolean(request.description && request.description !== request.title);
  const full = !brief || details;
  const model = brief ? permissionCard(request, task ?? { title: agentName, place: place ?? "" }, latestAgentQuote(timeline.data)) : null;

  async function answer(choice: PermissionChoice) {
    setBusy(true);
    setError(null);
    try {
      await getPaseoClient(serverId).agents.ref(agentId).respondToPermission({
        requestId: request.id,
        response: choice.behavior === "allow"
          ? { behavior: "allow", ...(choice.id ? { selectedActionId: choice.id } : {}) }
          : { behavior: "deny", ...(choice.id ? { selectedActionId: choice.id } : {}) },
      });
      void queryClient.invalidateQueries({ queryKey: ["mission-control"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  if (request.kind === "question") return <PermissionQuestionCard
    key={JSON.stringify([serverId, agentId, questionRequestVersion(request)])}
    {...{ serverId, agentId, agentName, place, task, openAgent, request, colors, compact, brief }} latest={latestAgentQuote(timeline.data)} />;

  return <View accessibilityLabel={`Permission request from ${model?.task.title ?? agentName}`} style={{ borderColor: colors.statusWarning, borderWidth: 1, borderLeftWidth: brief ? 3 : 4, borderRadius: 8, padding: compact || brief ? 9 : 11, gap: brief ? 5 : 6, backgroundColor: colors.surface1 }}>
    {model ? <>
      <TaskHeader badge={model.badge} badgeColor={colors.statusWarning} task={model.task} colors={colors} />
      <WhereLine where={model.where} colors={colors} />
      <NeedLine need={model.need} recommendation={model.recommendation} colors={colors} />
      {details ? <Text style={{ color: colors.foreground, fontSize: 12 }}>{request.title || request.name}</Text> : null}
    </> : <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <View style={{ borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3, backgroundColor: colors.surface2 }}>
          <Text style={{ color: colors.statusWarning, fontSize: 11, fontWeight: "700" }}>PERMISSION</Text>
        </View>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>{agentName}</Text>
      </View>
      {place ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>{place}</Text> : null}
      <Text style={{ color: colors.foreground, fontSize: 13 }}>{request.title || request.name}</Text>
    </>}
    {full && described ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{request.description}</Text> : null}
    {full && detail ? <Text selectable numberOfLines={compact && !brief ? 4 : brief ? undefined : 8} style={{ color: colors.foreground, fontFamily: "monospace", fontSize: 11, backgroundColor: colors.surface2, padding: 7, borderRadius: 5 }}>{detail}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      {permissionChoices(request).map(choice => <Pressable key={`${choice.behavior}-${choice.id ?? choice.label}`} accessibilityRole="button" accessibilityLabel={`${choice.label}: ${request.title || request.name}`} disabled={busy} onPress={() => void answer(choice)}
        style={{ minHeight: 40, paddingHorizontal: 12, justifyContent: "center", borderRadius: 7, borderWidth: 1, opacity: busy ? 0.5 : 1,
          borderColor: choice.tone === "danger" ? colors.statusDanger : choice.tone === "primary" ? colors.accent : colors.border,
          backgroundColor: choice.tone === "primary" ? colors.accent : "transparent" }}>
        <Text style={{ color: choice.tone === "primary" ? colors.accentForeground : choice.tone === "danger" ? colors.statusDanger : colors.foreground, fontSize: 12, fontWeight: "600" }}>{choice.label}</Text>
      </Pressable>)}
      {brief && (described || detail) ? <CompactLink colors={colors} label={(details ? "Hide details" : "Details")} accessibilityRole="button" accessibilityLabel={`Details of the permission request from ${agentName}`} onPress={() => setDetails(!details)} expanded={details} /> : null}
    </View>
    {brief ? <CardFooter serverId={serverId} agentId={agentId} version={request.id} openAgent={openAgent} colors={colors} /> : null}
  </View>;
}
