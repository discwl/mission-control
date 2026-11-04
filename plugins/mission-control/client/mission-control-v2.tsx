import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { attentionSections, attentionTasks, type AttentionTask } from "./needs-you-model";
import { CompactLink } from "./compact-link";
import { formatDateTime } from "./date-time";
import { useKanbanData } from "./kanban-data";
import { KanbanDetail } from "./kanban-detail";
import { missionControlV2ScreenId } from "./mission-control-v2-model";

type Colors = PluginSurfaceProps["theme"]["colors"];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function AttentionCard({ task, colors, choose }: { task: AttentionTask; colors: Colors; choose(): void }) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const row = task.item.row;
  return <Pressable accessibilityRole="button" accessibilityLabel={`${row.entry.task.title}. ${task.action}`} onPress={choose} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
    style={({ pressed }) => ({ gap: 8, padding: 16, borderWidth: 1, borderColor: focused ? colors.accent : colors.border, borderRadius: 12, backgroundColor: pressed || hovered ? colors.surface2 : colors.surface1 })}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
      <Text style={{ color: colors.foreground, fontSize: 16, lineHeight: 23, fontWeight: "600", flexShrink: 1 }}>{row.entry.task.title}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{row.hostLabel}{row.entry.task.ticket?.key ? ` · ${row.entry.task.ticket.key}` : ""}</Text>
    </View>
    <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 13 }}>{task.label}</Text>
    <Text style={{ color: colors.foregroundMuted, lineHeight: 21 }}>{task.why}</Text>
    <Text style={{ color: colors.foreground, fontWeight: "600", paddingTop: 3 }}>{task.action}</Text>
  </Pressable>;
}

/** Existing screen identity is retained so saved links still open the actionable page. */
export function MissionControlV2({ theme, host, layout, navigation, openAllWork }: PluginSurfaceProps & { openAllWork?: () => void }) {
  const colors = theme.colors;
  const query = useKanbanData(host.id);
  const snapshot = query.data;
  const [filterHost, setFilterHost] = useState("all");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [technical, setTechnical] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const compact = layout.compact || size.width < 800;
  const tasks = attentionTasks(query.tasks, filterHost, search);
  const selected = query.tasks.find(item => item.row.key === selection);
  const issues = snapshot?.hosts.filter(remote => remote.error || !remote.snapshot || !remote.snapshot.complete || !Number.isFinite(Date.parse(remote.snapshot.observedAt)) || query.now - Date.parse(remote.snapshot.observedAt) > 90_000) ?? [];
  const fleetWarnings = snapshot?.warnings ?? [];
  const incomplete = query.isError || issues.length > 0 || fleetWarnings.length > 0;
  const clear = () => { setFilterHost("all"); setSearch(""); };
  const allWork = () => { try { openAllWork?.(); } catch (cause) { setError(message(cause)); } };
  const refresh = () => { void query.refetch(); };
  return <View onLayout={event => setSize(event.nativeEvent.layout)} style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}>
    {selected && snapshot ? <KanbanDetail key={selected.row.key} item={selected} snapshot={snapshot} colors={colors} compact={compact} height={size.height} navigation={navigation} close={() => setSelection(null)} refresh={refresh} /> : <>
      <View style={{ padding: compact ? 16 : 24, gap: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1, minWidth: 180, gap: 5 }}><Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 27, fontWeight: "700" }}>Needs you</Text><Text style={{ color: colors.foregroundMuted, lineHeight: 21 }}>Questions, final decisions and work that needs help.</Text></View>
          <CompactLink label="All work" icon="ArrowRight" colors={colors} disabled={!openAllWork} onPress={allWork} />
          <CompactLink label={query.isFetching ? "Refreshing…" : "Refresh"} colors={colors} disabled={query.isFetching} onPress={refresh} />
        </View>
        {error ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>{error}</Text> : null}
        {query.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>Task updates could not be loaded. Refresh or reconnect before relying on saved results.</Text> : null}
        <View style={{ gap: 5 }}><Text style={{ color: colors.foreground, fontSize: 13 }}>Find a task</Text><TextInput accessibilityLabel="Find a task that needs you" value={search} onChangeText={setSearch} placeholder="Search title, ticket or host" placeholderTextColor={colors.foregroundMuted} style={{ color: colors.foreground, backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 7, padding: 11 }} /></View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8 }}>
          <CompactLink label="All hosts" selected={filterHost === "all"} colors={colors} onPress={() => setFilterHost("all")} />
          {[...(snapshot?.hosts ?? [])].sort((a, b) => a.label.localeCompare(b.label)).map(remote => <CompactLink key={remote.serverId} label={remote.label} selected={filterHost === remote.serverId} colors={colors} onPress={() => setFilterHost(remote.serverId)} />)}
        </ScrollView>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 16 : 24, gap: 28 }}>
        {query.isPending ? <Text style={{ color: colors.foregroundMuted }}>Checking which tasks need your attention…</Text> : null}
        {!query.isPending && !tasks.length ? <View style={{ gap: 9, maxWidth: 850 }}>
          <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 20, fontWeight: "600" }}>{search || filterHost !== "all" ? "No matching tasks need you" : incomplete ? "Some tasks could not be checked" : "No tasks need you right now"}</Text>
          <Text style={{ color: colors.foregroundMuted, lineHeight: 22 }}>{incomplete ? "Unavailable or incomplete host updates do not mean the work is finished. Reconnect and refresh to check those tasks." : "Routine planning, implementation, testing and independent reviews continue without an approval here. Follow their progress in All work."}</Text>
          {search || filterHost !== "all" ? <CompactLink label="Clear filters" colors={colors} onPress={clear} /> : null}
          <CompactLink label="View all work" colors={colors} disabled={!openAllWork} onPress={allWork} />
        </View> : null}
        {attentionSections.map(section => {
          const group = tasks.filter(task => task.section === section.id);
          return group.length ? <View key={section.id} style={{ gap: 12, maxWidth: 1000 }}>
            <View style={{ gap: 5 }}><Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 19, fontWeight: "600" }}>{section.title} · {group.length}</Text><Text style={{ color: colors.foregroundMuted, lineHeight: 21 }}>{section.description}</Text></View>
            {group.map(task => <AttentionCard key={task.item.row.key} task={task} colors={colors} choose={() => setSelection(task.item.row.key)} />)}
          </View> : null;
        })}
        {issues.length || fleetWarnings.length ? <View style={{ gap: 8, maxWidth: 1000 }}><Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 17, fontWeight: "600" }}>Hosts that need checking</Text>{issues.map(remote => <Text key={remote.serverId} style={{ color: colors.statusWarning, lineHeight: 21 }}>{remote.label}: {remote.snapshot ? "the latest task status could not be confirmed." : "task information is unavailable."} Reconnect or refresh to check its work.</Text>)}{fleetWarnings.length ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning, lineHeight: 21 }}>Some hosts or tasks may be missing from this view. Check the host connections and refresh before relying on this list.</Text> : null}{fleetWarnings.map((warning, index) => <Text key={`fleet-warning:${index}`} selectable style={{ color: colors.statusWarning, lineHeight: 21 }}>{warning}</Text>)}</View> : null}
        <View style={{ gap: 9, maxWidth: 1000 }}>
          {snapshot ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Last update {formatDateTime(snapshot.observedAt)}</Text> : null}
          <CompactLink label={technical ? "Hide technical details" : "Technical details"} expanded={technical} colors={colors} onPress={() => setTechnical(!technical)} />
          {technical ? <View style={{ gap: 8 }}>
            {query.isError ? <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{message(query.error)}</Text> : null}
            {issues.map(remote => <Text key={remote.serverId} selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{remote.label}: {remote.error ?? remote.snapshot?.warnings.join(" · ") ?? "No host response"}</Text>)}
            {tasks.map(task => <Text key={task.item.row.key} selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{task.item.row.key}{"\n"}{task.item.row.entry.run?.runId ?? "No run"}{"\n"}{task.item.row.entry.problem ?? task.item.row.next}</Text>)}
          </View> : null}
        </View>
      </ScrollView>
    </>}
  </View>;
}

export function registerMissionControlV2(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: missionControlV2ScreenId, title: "Needs you", Component: props => <MissionControlV2 {...props} openAllWork={() => client.openScreen({ screenId: "kanban" })} /> }),
    client.addSidebarHeaderItem({ id: missionControlV2ScreenId, title: "Needs you", Component: ({ currentScreen, openScreen }) => <SidebarRow icon="CircleHelp" active={currentScreen?.screenId === missionControlV2ScreenId} onPress={() => openScreen({ screenId: missionControlV2ScreenId })} /> }),
    client.addCommandCenterItem({ id: "open-mission-control-v2", title: "Open Needs you", icon: "CircleHelp", context: "global", keywords: ["attention", "questions", "publish", "approval"], onSelect: () => client.openScreen({ screenId: missionControlV2ScreenId }) }),
    client.addSlashCommand({ name: "mission-control-v2", description: "Open tasks that need your answer or final decision", argumentHint: "", context: "workspace", onSubmit: () => client.openScreen({ screenId: missionControlV2ScreenId }) }),
  ];
  return () => removers.forEach(remove => remove());
}
