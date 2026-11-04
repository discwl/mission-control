import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useHosts, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { HostRpcProvider, useMissionControlCopy, useRpc } from "./host-rpc";
import { authorizeActionDelivery, checkActionDelivery, type ActionDeliveryPlan } from "../shared/action-delivery";
import { CompactLink } from "./compact-link";
type Preview = { ready: boolean; reason: string; plan: ActionDeliveryPlan | null; completed?: boolean };
export function RemoteActionDeliveryCard(props: ComponentProps<typeof ActionDeliveryCard>) {
  const bridge = useMissionControlCopy(props.serverId);
  const online = useHosts().some(host => host.serverId === props.serverId && host.status === "online");
  if (!online) return <Text style={{ color: props.colors.statusWarning }}>This host is offline. Reconnect it to review the prepared actions.</Text>;
  if (!("copy" in bridge)) return <Text style={{ color: props.colors.foregroundMuted }}>Connecting to this host's Mission Control plugin…</Text>;
  return <HostRpcProvider copy={bridge.copy}><ActionDeliveryCard {...props} /></HostRpcProvider>;
}
export function ActionDeliveryCard({ serverId, taskId, actorId, colors, renderFeedback }: {
  serverId: string; taskId: string; actorId: string; colors: PluginSurfaceProps["theme"]["colors"]; renderFeedback?: (plan: ActionDeliveryPlan) => ReactNode;
}) {
  const check = useRpc(checkActionDelivery); const authorize = useRpc(authorizeActionDelivery);
  const [expanded, setExpanded] = useState(false); const [preview, setPreview] = useState<Preview | null>(null);
  const [reload, setReload] = useState(0); const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false); const [message, setMessage] = useState("");
  const authorizationStarted = useRef(false);
  useEffect(() => {
    if (!expanded) return;
    let active = true; setPreview(null);
    void check({ serverId, taskId }).then(value => { if (active) setPreview(value); })
      .catch(error => { if (active) setMessage(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [expanded, serverId, taskId, reload, check]);
  async function approve() {
    if (!preview?.ready || !preview.plan || preview.plan.taskId !== taskId || preview.plan.kind !== "actions" || busy || attempted || authorizationStarted.current) return;
    const fingerprint = preview.plan.fingerprint;
    authorizationStarted.current = true;
    setBusy(true); setAttempted(true); setMessage("");
    try {
      const result = await authorize({ serverId, taskId, actorId, fingerprint });
      setMessage(result.reason); setReload(value => value + 1);
    } catch (error) {
      setMessage(`Authorization could not be confirmed. Check the worker before retrying. ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  }
  const bundle = preview?.plan?.bundle;
  return <View style={{ gap: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 12 }}>
    <CompactLink label="Review final actions or report" colors={colors} expanded={expanded} onPress={() => setExpanded(value => !value)} />
    {expanded ? <>
      {!preview && !message ? <Text style={{ color: colors.foregroundMuted }}>Checking the saved version and both reviews…</Text> : null}
      {preview ? <Text style={{ color: preview.ready || preview.completed ? colors.foreground : colors.statusWarning }}>{preview.reason}</Text> : null}
      {bundle && preview?.plan ? <>
        <Text style={{ color: colors.foreground, fontWeight: "600" }}>{bundle.summary}</Text>
        <Text selectable style={{ color: colors.foreground }}>Environment: {bundle.environment}</Text>
        {bundle.prerequisites.length ? <View style={{ gap: 4 }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>Prerequisites</Text>{bundle.prerequisites.map((item, i) => <Text key={i} selectable style={{ color: colors.foreground }}>{i + 1}. {item}</Text>)}</View> : null}
        {bundle.steps.map((step, i) => <View key={i} style={{ gap: 4 }}><Text selectable style={{ color: colors.foreground }}>{i + 1}. {step.instruction}</Text><Text selectable style={{ color: colors.foregroundMuted }}>Effect: {step.effect}</Text></View>)}
        <Text style={{ color: colors.foreground, fontWeight: "600" }}>Verification</Text>
        {bundle.verification.map((item, i) => <Text key={i} selectable style={{ color: colors.foreground }}>{i + 1}. {item}</Text>)}
        <Text selectable style={{ color: colors.foreground }}>Rollback: {bundle.rollback}</Text>
        {bundle.report ? <Text selectable style={{ color: colors.foreground }}>{bundle.report}</Text> : null}
        <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>Reviewed version: {preview.plan.revision}</Text>
        {preview.plan.kind === "actions" ? <>
          {preview.ready && !busy && !attempted && !authorizationStarted.current ? renderFeedback?.(preview.plan) : null}
          <Text style={{ color: colors.foregroundMuted }}>Authorize only the steps shown above in this environment. Changed steps require fresh validation, reviews and authorization.</Text>
          <CompactLink label={busy ? "Authorizing…" : attempted ? "Authorization requested — check status" : "Authorize these actions"} colors={colors} disabled={!preview.ready || busy || attempted} onPress={() => void approve()} />
        </> : <Text style={{ color: colors.foregroundMuted }}>This is a reviewed read-only report. No action authorization is requested.</Text>}
      </> : null}
      {message ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>{message}</Text> : null}
      <CompactLink label="Refresh delivery status" colors={colors} disabled={busy} onPress={() => { setMessage(""); setReload(value => value + 1); }} />
    </> : null}
  </View>;
}
