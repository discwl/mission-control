import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { agentCleanupSettings, archiveAgentCleanup, listAgentCleanupHistory, scanAgentCleanup, type CleanupScope } from "../shared/agent-cleanup";
import type { TrackedPullRequest } from "../shared/pull-request";
import { AppModal } from "./app-modal";
import { CleanupDialog } from "./pull-request-action";
import { rosterKey } from "./roster";
import { formatDateTime } from "./date-time";

type Colors = PluginSurfaceProps["theme"]["colors"];
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function AgentCleanupDialog({ scope, colors, online, onClose }: { scope: CleanupScope; colors: Colors; online: boolean; onClose: () => void }) {
  const scan = useRpc(scanAgentCleanup), execute = useRpc(archiveAgentCleanup), readHistory = useRpc(listAgentCleanupHistory);
  const queryClient = useQueryClient();
  const preview = useQuery({ queryKey: ["mission-control", "agent-cleanup", scope.serverId, scope.workspaceId, scope.agentId ?? "all"],
    queryFn: () => scan(scope), enabled: online, staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [showHistory, setShowHistory] = useState(false);
  const [deliveryTarget, setDeliveryTarget] = useState<TrackedPullRequest | null>(null);
  const [now, setNow] = useState(Date.now);
  const lock = useRef(false);
  const archive = useMutation({
    mutationFn: () => execute({ ...scope, scanId: preview.data!.scanId, agentIds: [...selected] }),
    onSettled: () => {
      lock.current = false;
      void queryClient.invalidateQueries({ queryKey: rosterKey(scope.serverId) });
      void queryClient.invalidateQueries({ queryKey: ["mission-control", "agent-cleanup-history", scope.serverId, scope.workspaceId] });
    },
  });
  const history = useQuery({ queryKey: ["mission-control", "agent-cleanup-history", scope.serverId, scope.workspaceId],
    queryFn: () => readHistory({ serverId: scope.serverId, workspaceId: scope.workspaceId }), enabled: online && showHistory, retry: false });
  useEffect(() => { setSelected(new Set()); }, [preview.data?.scanId]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  const expired = Boolean(preview.data && Date.parse(preview.data.expiresAt) <= now);
  const busy = archive.isPending || preview.isFetching;
  const eligible = preview.data?.rows.filter(row => row.disposition === "eligible") ?? [];
  const ready = online && !busy && !expired && !archive.data && !archive.isError && selected.size > 0;
  function confirm() { if (!ready || lock.current) return; lock.current = true; archive.mutate(); }
  function rescan() { if (busy || lock.current) return; archive.reset(); setSelected(new Set()); void preview.refetch(); }
  function toggle(id: string) { if (busy) return; setSelected(current => { const next = new Set(current); if (!next.delete(id) && next.size < 100) next.add(id); return next; }); }
  const button = (label: string, press: () => void, unavailable = false, primary = false) => <Pressable accessibilityRole="button" accessibilityLabel={label}
    disabled={unavailable} onPress={press} style={{ minHeight: 40, paddingHorizontal: 12, justifyContent: "center", borderWidth: 1, borderRadius: 7,
      borderColor: primary ? colors.accent : colors.border, backgroundColor: primary ? colors.accent : "transparent", opacity: unavailable ? 0.45 : 1 }}>
    <Text style={{ color: primary ? colors.accentForeground : colors.foreground, fontSize: 12, fontWeight: "600" }}>{label}</Text>
  </Pressable>;
  return <>
    <AppModal colors={colors} title="Clean up agents" maxHeight={640} open={!deliveryTarget} onOpenChange={open => { if (!open && !lock.current) onClose(); }} icon={<Icon name="BrushCleaning" size={18} color={colors.foreground} />}>
      <AppModal.Content scrollable={false}>
        <View style={{ flex: 1, minHeight: 0, gap: 12 }}>
          <ScrollView nestedScrollEnabled style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ gap: 12 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Host {scope.serverId} · Workspace {scope.workspaceId}{scope.agentId ? " · Selected agent family" : " · All agent families"}</Text>
          <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>Archive finished conversations while keeping chat history, task records, workspaces and branches. Open tabs, pinned workspaces and families waiting on work or your input are kept.</Text>
          {!online ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>Reconnect this host to scan or archive.</Text> : null}
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Scans run when you open this window or choose Scan again. Select families and confirm to archive them.</Text>
          {preview.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{errorText(preview.error)}</Text> : null}
          {preview.data ? <>
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Delivered/closed tasks: {preview.data.policy.deliveredDays} days · Unlinked conversations: {preview.data.policy.unlinkedDays} days · Settings → Plugins → Mission Control → Agent cleanup</Text>
            {preview.data.warnings.map((warning, index) => <Text key={index} accessibilityRole="alert" style={{ color: colors.statusWarning, fontSize: 12 }}>{warning}</Text>)}
            <View style={{ gap: 12 }}>
              {(["eligible", "keep", "unknown"] as const).map(disposition => {
                const rows = preview.data!.rows.filter(row => row.disposition === disposition);
                return <View key={disposition} style={{ gap: 6 }}>
                  <Text accessibilityRole="header" style={{ color: colors.foreground, fontWeight: "600", fontSize: 13 }}>{disposition === "eligible" ? "Eligible" : disposition === "keep" ? "Keep" : "Couldn't verify"} ({rows.length})</Text>
                  {rows.map(row => <Pressable key={row.agentId} accessibilityRole={disposition === "eligible" ? "checkbox" : undefined}
                    accessibilityLabel={`${row.title}: ${row.reason}`} accessibilityState={{ checked: selected.has(row.agentId), disabled: busy || disposition !== "eligible" }}
                    disabled={busy || disposition !== "eligible"} onPress={() => toggle(row.agentId)}
                    style={{ flexDirection: "row", gap: 9, borderWidth: 1, borderColor: selected.has(row.agentId) ? colors.accent : colors.border, borderRadius: 8, padding: 10, minHeight: 44, backgroundColor: colors.surface1 }}>
                    {disposition === "eligible" ? <View style={{ width: 18, height: 18, borderWidth: 1.5, borderRadius: 4, borderColor: selected.has(row.agentId) ? colors.accent : colors.foregroundMuted,
                      backgroundColor: selected.has(row.agentId) ? colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
                      {selected.has(row.agentId) ? <Text style={{ color: colors.accentForeground, fontSize: 12 }}>✓</Text> : null}
                    </View> : <Icon name={disposition === "unknown" ? "CircleHelp" : "ShieldCheck"} size={17} color={disposition === "unknown" ? colors.statusWarning : colors.foregroundMuted} />}
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 13 }}>{row.title}</Text>
                      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{row.reason}</Text>
                      {row.lastActivityAt ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{row.activityBasis === "conversation" ? "Last conversation activity" : "Latest known update (conservative)"}: {formatDateTime(row.lastActivityAt)}</Text> : null}
                      {row.taskTitles.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Tasks: {row.taskTitles.join(" · ")}</Text> : null}
                      {disposition === "eligible" ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{row.archiveIds.length} will archive · {row.detachedIds.length} detach and remain · {row.untouchedIds.length} remain unchanged{row.manualOnly ? " · Manual choice" : ""}</Text> : null}
                    </View>
                  </Pressable>)}
                </View>;
              })}
            </View>
            {eligible.some(row => !row.manualOnly) && !archive.data ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {button("Select finished task families", () => setSelected(new Set(eligible.filter(row => !row.manualOnly).slice(0, 100).map(row => row.agentId))), busy)}
              {button("Clear selection", () => setSelected(new Set()), busy || !selected.size)}
            </View> : null}
            {preview.data.mergedPullRequests.map(pr => <View key={pr.taskId} style={{ gap: 6, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8 }}>
              <Text style={{ color: colors.foreground, fontSize: 12 }}>Merged PR: {pr.title}. Delivery cleanup has its own workspace and Git checks.</Text>
              {button("Check delivery cleanup", () => setDeliveryTarget(pr), busy)}
            </View>)}
          </> : null}
          {expired && !archive.data ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>This preview expired. Scan again before archiving.</Text> : null}
          {archive.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{errorText(archive.error)} Scan again before any further cleanup.</Text> : null}
          {archive.data?.results.map(result => <Text key={result.agentId} accessibilityLiveRegion="polite" style={{ color: result.outcome === "failed" ? colors.statusDanger : result.outcome === "skipped" ? colors.statusWarning : colors.statusSuccess, fontSize: 12 }}>{result.title}: {result.detail}</Text>)}
          {button(showHistory ? "Hide recent cleanup" : "Show recent cleanup", () => setShowHistory(!showHistory), busy)}
          {showHistory ? <View style={{ gap: 5 }}>
            {history.isPending ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Reading cleanup history…</Text> : null}
            {history.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>{errorText(history.error)}</Text> : null}
            {!history.isPending && !history.isError && !history.data?.entries.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No cleanup recorded in this workspace.</Text> : null}
            {history.data?.entries.map(entry => <Text key={entry.id} style={{ color: colors.foregroundMuted, fontSize: 11 }}>{formatDateTime(entry.at)} · {entry.title} · {entry.outcome}: {entry.detail}</Text>)}
          </View> : null}
          </ScrollView>
          {preview.isFetching && online ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 12, flexShrink: 0 }}>Scanning families, tasks and recent activity…</Text> : null}
          {preview.data && preview.dataUpdatedAt > 0 && !preview.isFetching && !preview.isError ? <Text accessibilityLiveRegion="polite" style={{ color: colors.statusSuccess, fontSize: 12, flexShrink: 0 }}>Scan completed at {new Date(preview.dataUpdatedAt).toLocaleTimeString()} · {eligible.length} eligible · {preview.data.rows.filter(row => row.disposition === "keep").length} kept · {preview.data.rows.filter(row => row.disposition === "unknown").length} couldn't verify</Text> : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", flexShrink: 0, gap: 8 }}>
            {button("Close", onClose, busy)}
            {button(preview.isFetching ? "Scanning…" : "Scan again", rescan, busy || !online)}
            {!archive.data ? button(archive.isPending ? "Archiving…" : `Archive selected (${selected.size})`, confirm, !ready, true) : null}
          </View>
        </View>
      </AppModal.Content>
    </AppModal>
    <CleanupDialog serverId={scope.serverId} online={online} colors={colors} target={deliveryTarget} onClose={() => { setDeliveryTarget(null); rescan(); }} />
  </>;
}

export function AgentCleanupSettings({ theme, host }: PluginSurfaceProps) {
  return <CleanupSettingsBody key={host.id} colors={theme.colors} />;
}
function CleanupSettingsBody({ colors }: { colors: Colors }) {
  const settings = useSettings(agentCleanupSettings);
  const [delivered, setDelivered] = useState("");
  const [unlinked, setUnlinked] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (settings.status === "ready" && !dirty) { setDelivered(String(settings.values.deliveredDays)); setUnlinked(String(settings.values.unlinkedDays)); } }, [settings.status, settings.status === "ready" ? settings.revision : null, dirty]);
  if (settings.status !== "ready") return <View style={{ padding: 16, gap: 12 }}>
    <Text style={{ color: colors.foreground }}>{settings.status === "loading" ? "Loading cleanup settings…" : settings.error}</Text>
    {settings.status !== "loading" ? <Pressable accessibilityRole="button" onPress={settings.reload}><Text style={{ color: colors.accent }}>Reload settings</Text></Pressable> : null}
    {settings.status === "invalid" ? <Pressable accessibilityRole="button" disabled={settings.saving} onPress={() => void settings.reset()}><Text style={{ color: colors.accent }}>Reset to defaults</Text></Pressable> : null}
  </View>;
  const values = { deliveredDays: Number(delivered), unlinkedDays: Number(unlinked) };
  const valid = /^\d+$/.test(delivered) && /^\d+$/.test(unlinked) && agentCleanupSettings.schema.safeParse(values).success;
  const field = (label: string, value: string, change: (value: string) => void) => <View style={{ gap: 6 }}>
    <Text style={{ color: colors.foreground, fontSize: 13 }}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} keyboardType="number-pad" editable={!settings.saving} onChangeText={text => { setDirty(true); change(text); }}
      style={{ color: colors.foreground, borderColor: colors.border, borderWidth: 1, borderRadius: 7, padding: 10, maxWidth: 160 }} />
  </View>;
  return <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
    <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "600" }}>Agent cleanup</Text>
    <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>These settings apply to this host's manual scans. Nothing is automatically archived. Eligibility still requires no active work or pending input.</Text>
    {field("Keep delivered or closed task conversations for days", delivered, setDelivered)}
    {field("Offer unlinked inactive conversations after days", unlinked, setUnlinked)}
    {!valid ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Enter whole numbers from 1 to 365.</Text> : null}
    {settings.saveError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{settings.saveError}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Save cleanup settings" disabled={!valid || !dirty || settings.saving}
      onPress={async () => { if (await settings.save(values, settings.revision)) setDirty(false); }}
      style={{ minHeight: 40, alignSelf: "flex-start", paddingHorizontal: 14, justifyContent: "center", borderRadius: 7, backgroundColor: colors.accent, opacity: valid && dirty && !settings.saving ? 1 : 0.5 }}>
      <Text style={{ color: colors.accentForeground }}>{settings.saving ? "Saving…" : "Save"}</Text>
    </Pressable>
  </ScrollView>;
}
