import { CompactLink } from "./compact-link";
import { getPaseoClient, openExternalUrl, useRpc, type PluginHostSummary, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { getMorningStatus, importMorningItems, startMorningCheck, type MorningStatus } from "../shared/morning";
import { taskSummaryKey } from "../shared/task-summary";
import { ticketIdentity, ticketSystemLabels } from "../shared/tickets";
import { formatDateTime } from "./date-time";
import { MarkdownPreview } from "./markdown-preview";

type Colors = PluginSurfaceProps["theme"]["colors"];
type Item = MorningStatus["missing"][number];
type Props = {
  // The host this Mission Control installation serves; only its vault is reachable.
  ownServerId: string;
  host: PluginHostSummary;
  workspace: { id: string; name: string };
  colors: Colors;
  navigation?: PluginSurfaceProps["navigation"];
};

const trackerText = (report: NonNullable<MorningStatus["report"]>) =>
  report.tracker.mode === "unavailable" ? "No tracker tools in that session"
    : report.tracker.mode === "fixture" ? `Test fixture · ${report.items.length} items`
      : `${report.tracker.systems.map(system => ticketSystemLabels[system]).join(" and ")} · ${report.items.length} current-sprint items`;

export function MorningCheck({ ownServerId, host, workspace, colors, navigation }: Props) {
  const own = host.serverId === ownServerId;
  const online = host.status === "online";
  const queryClient = useQueryClient();
  const readStatus = useRpc(getMorningStatus);
  const start = useRpc(startMorningCheck);
  const importItems = useRpc(importMorningItems);
  const [provider, setProvider] = useState<string | null>(null);
  const [fixture, setFixture] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<"start" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);
  const query = useQuery({
    queryKey: ["mission-control", "morning", ownServerId],
    queryFn: () => readStatus({ serverId: ownServerId }),
    enabled: own && online,
    refetchInterval: current => (current.state.data?.agent?.busy ? 5_000 : 30_000),
    retry: false,
  });
  const paseo = own && online ? getPaseoClient(host.serverId) : null;
  const providers = useQuery({ queryKey: ["mission-control", "morning-providers", host.serverId], queryFn: () => paseo!.providers.listAvailable(), enabled: Boolean(paseo), staleTime: 60_000, retry: false });
  const available = providers.data?.providers.filter(entry => entry.available) ?? [];
  const chosenProvider = available.find(entry => entry.provider === provider)?.provider ?? available[0]?.provider;
  const models = useQuery({ queryKey: ["mission-control", "morning-models", host.serverId, chosenProvider], queryFn: () => paseo!.providers.listModels(chosenProvider!), enabled: Boolean(paseo && chosenProvider), staleTime: 60_000, retry: false });
  const choices = models.data?.models ?? [];
  const model = choices.find(entry => entry.isDefault) ?? choices[0];
  const status = query.data;
  const report = status?.report;
  const missing = status?.missing ?? [];
  const picked = selected.filter(identity => missing.some(item => ticketIdentity(item) === identity));
  const button = { minHeight: 44, paddingHorizontal: 12, borderRadius: 7, justifyContent: "center" as const, borderWidth: 1, borderColor: colors.border };
  const failure = error ?? (query.error ? String(query.error instanceof Error ? query.error.message : query.error) : null);

  async function run() {
    if (!chosenProvider || !model || busy) return;
    setBusy("start"); setError(null); setNotice(null);
    try {
      await start({ serverId: ownServerId, workspaceId: workspace.id, provider: `${chosenProvider}/${model.id}`, fixture });
      setNotice("Morning check started. The report appears here when the agent writes it.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); await query.refetch(); }
  }
  async function importPicked() {
    if (!report || !picked.length || busy) return;
    setBusy("import"); setError(null); setNotice(null);
    try {
      const result = await importItems({ serverId: ownServerId, workspaceId: workspace.id, reportId: report.reportId, items: picked });
      setSelected([]);
      setNotice(`Imported ${result.created.length} ${result.created.length === 1 ? "task" : "tasks"} into ${workspace.name}${result.skipped.length ? `; ${result.skipped.length} already had a task` : ""}.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mission-control", "tasks", ownServerId] }),
        queryClient.invalidateQueries({ queryKey: taskSummaryKey(ownServerId) }),
      ]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); await query.refetch(); }
  }
  function openAgent(agentId: string) {
    try { navigation?.openAgent({ serverId: host.serverId, agentId }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  function ticketRow(item: Item, trailing: ReactNode) {
    return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 }}>
      {trailing}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.foreground, fontSize: 13 }}><Text style={{ fontWeight: "600" }}>{item.key}</Text> · {item.title}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ticketSystemLabels[item.system]}{item.status ? ` · ${item.status}` : ""}{item.sprint ? ` · ${item.sprint}` : ""}</Text>
      </View>
      <CompactLink colors={colors} label={"Open ↗"} accessibilityRole="link" accessibilityLabel={`Open ${item.key} in ${ticketSystemLabels[item.system]}`} onPress={() => { void openExternalUrl(item.url).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }} />
    </View>;
  }

  return <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10, gap: 8 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
      <Icon name="ListTodo" size={15} color={colors.foregroundMuted} />
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600", flex: 1 }}>Morning check · {host.label}</Text>
      {own && online ? <Pressable accessibilityRole="button" accessibilityLabel="Refresh Morning check" disabled={query.isFetching} onPress={() => { setError(null); void query.refetch(); }} style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}><Icon name="RefreshCw" size={14} color={colors.foregroundMuted} /></Pressable> : null}
    </View>
    {!own ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Open Mission Control on {host.label} to run its Morning check. Each host reads its own vault and tracker tools.</Text> : !online ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Reconnect this host to run its Morning check.</Text> : <>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Starts an agent in this workspace that reads your current-sprint Jira or Azure DevOps items (read only), lists the ones not in Mission Control yet, and reviews yesterday's handoffs, open decisions, and blocked or idle tasks. Imported tasks are added to this workspace.</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        {available.map(entry => <Pressable key={entry.provider} accessibilityRole="button" accessibilityState={{ selected: chosenProvider === entry.provider }} disabled={busy !== null} onPress={() => setProvider(entry.provider)} style={{ ...button, borderColor: chosenProvider === entry.provider ? colors.accent : colors.border }}><Text style={{ color: colors.foreground, fontSize: 12 }}>{entry.provider}</Text></Pressable>)}
        {model ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Model: {model.label} (default)</Text> : null}
        {providers.isPending || models.isFetching ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Loading models…</Text> : null}
        {providers.error || models.error || providers.data?.error || models.data?.error ? <Text style={{ color: colors.statusDanger, fontSize: 12 }}>{String(providers.error ?? models.error ?? providers.data?.error ?? models.data?.error)}</Text> : null}
        {!providers.isPending && !available.length ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>No available providers. Check this host's Paseo provider settings.</Text> : null}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: fixture }} disabled={busy !== null} onPress={() => setFixture(!fixture)} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 4 }}>
          <Text style={{ color: fixture ? colors.accent : colors.foregroundMuted, fontSize: 12 }}>{fixture ? "☑" : "☐"} Use test fixture instead of Jira/Azure DevOps</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={busy !== null || !model || status?.agent?.busy} onPress={() => void run()} style={{ ...button, backgroundColor: colors.accent, borderColor: colors.accent, opacity: busy !== null || !model || status?.agent?.busy ? 0.5 : 1 }}>
          <Text style={{ color: colors.accentForeground, fontWeight: "600", fontSize: 13 }}>{busy === "start" ? "Starting…" : "Run Morning check"}</Text>
        </Pressable>
      </View>
      {status?.launch ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text style={{ color: status.launch.error ? colors.statusWarning : colors.foregroundMuted, fontSize: 12 }}>
          Last started {formatDateTime(status.launch.createdAt)}{status.launch.fixture ? " with the test fixture" : ""} · {status.launch.error ? `not confirmed: ${status.launch.error}` : status.agent ? `agent ${status.agent.busy ? "working" : status.agent.status}` : "agent closed or archived"}
        </Text>
        {navigation && (status.agent || status.launch.phase === "sending") ? <CompactLink colors={colors} label={"Open agent →"} accessibilityRole="button" onPress={() => openAgent(status.agent?.id ?? status.launch!.agentId)} /> : null}
      </View> : null}
      {failure ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{failure}</Text> : null}
      {notice ? <Text style={{ color: colors.statusSuccess, fontSize: 12 }}>{notice}</Text> : null}
      {query.isPending ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Reading the latest report…</Text> : null}
      {status?.reportError ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>The latest report can't be read: {status.reportError}</Text> : null}
      {status && !report && !status.reportError ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No Morning check report yet.</Text> : null}
      {report ? <View style={{ gap: 8 }}>
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>Latest report · {formatDateTime(report.createdAt)}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{trackerText(report)} · {report.review.handoffs} handoffs · {report.review.openDecisions} open decisions · {report.review.blocked} blocked · {report.review.idle} idle</Text>
        {report.tracker.mode !== "unavailable" ? <>
          <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>Not in Mission Control ({missing.length})</Text>
          {!missing.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Every item in this report has a task.</Text> : null}
          {missing.map(item => {
            const identity = ticketIdentity(item);
            const checked = picked.includes(identity);
            return <View key={identity}>{ticketRow(item, <Pressable accessibilityRole="checkbox" accessibilityLabel={`Import ${item.key}`} accessibilityState={{ checked }} disabled={busy !== null} onPress={() => setSelected(checked ? selected.filter(value => value !== identity) : [...selected, identity])} style={{ minWidth: 32, minHeight: 44, justifyContent: "center" }}>
              <Text style={{ color: checked ? colors.accent : colors.foregroundMuted, fontSize: 16 }}>{checked ? "☑" : "☐"}</Text>
            </Pressable>)}</View>;
          })}
          {missing.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <Pressable accessibilityRole="button" disabled={!picked.length || busy !== null} onPress={() => void importPicked()} style={{ ...button, borderColor: colors.accent, opacity: !picked.length || busy !== null ? 0.5 : 1 }}>
              <Text style={{ color: colors.accent, fontWeight: "600", fontSize: 13 }}>{busy === "import" ? "Importing…" : `Import ${picked.length ? `${picked.length} ` : ""}selected into ${workspace.name}`}</Text>
            </Pressable>
            <CompactLink colors={colors} label={(picked.length === missing.length ? "Clear selection" : "Select all")} accessibilityRole="button" disabled={busy !== null} onPress={() => setSelected(picked.length === missing.length ? [] : missing.map(ticketIdentity))} />
          </View> : null}
          {status!.imported.length ? <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>Already in Mission Control ({status!.imported.length})</Text> : null}
          {status!.imported.map(({ item, tasks }) => <View key={ticketIdentity(item)}>{ticketRow(item, <Text style={{ color: colors.statusSuccess, fontSize: 12, minWidth: 32 }}>✓</Text>)}
            <Text style={{ color: colors.foregroundMuted, fontSize: 11, marginLeft: 40 }}>{tasks.map(task => `${task.title} (${task.status.replaceAll("_", " ")})`).join(" · ")}</Text>
          </View>)}
        </> : null}
        <CompactLink colors={colors} label={(showReport ? "Hide full report ▴" : "Show full report ▾")} accessibilityRole="button" onPress={() => setShowReport(!showReport)} expanded={showReport} />
        {showReport ? <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 7, padding: 10 }}>
          <MarkdownPreview content={report.body} colors={colors} documentPath={report.file} />
          <Text selectable style={{ color: colors.foregroundMuted, fontSize: 11, marginTop: 8 }}>{report.file}</Text>
        </View> : null}
      </View> : null}
    </>}
  </View>;
}
