import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { CompactLink } from "./compact-link";
import { formatDateTime } from "./date-time";
import { useKanbanData } from "./kanban-data";
import { KanbanDetail } from "./kanban-detail";
import { KanbanIntake } from "./kanban-intake";
import { filterKanban, kanbanCounts, kanbanSidebarCounts, kanbanLanes, kanbanLayout, kanbanScreenId, type KanbanFocus, type KanbanLane, type KanbanTask } from "./kanban-model";

import { KanbanFilterMenu } from "./kanban-filter-menu";
import { changeKanbanScope, emptyKanbanScope, kanbanFilterOptions, matchesKanbanScope, type ScopeKind } from "./kanban-filters-model";

type Colors = PluginSurfaceProps["theme"]["colors"];
const focuses: KanbanFocus[] = ["All work", "Needs you", "Running"];
function laneColor(lane: KanbanLane, colors: Colors) {
  return lane === "attention" || lane === "plan" ? colors.statusWarning : lane === "review" || lane === "done" ? colors.statusSuccess : colors.foregroundMuted;
}

function TaskCard({ item, colors, open }: { item: KanbanTask; colors: Colors; open(): void }) {
  const row = item.row;
  const [hovered, setHovered] = useState(false);
  return <Pressable accessibilityRole="button" accessibilityLabel={`${row.hostLabel}, ${row.entry.task.ticket?.key ?? row.entry.task.title}, ${item.label}. ${item.action}`} onPress={open}
    onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
    style={({ pressed }) => ({ padding: 14, gap: 10, marginBottom: 10, backgroundColor: hovered || pressed ? colors.surface1 : colors.surface2, borderRadius: 9, borderWidth: 1, borderColor: hovered ? colors.foregroundMuted : colors.border, minHeight: 148 })}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
      <Icon name="Server" size={13} color={colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 12, flex: 1 }}>{row.hostLabel} · {row.entry.task.ticket?.key ?? row.entry.task.projectId}</Text>
      {row.state === "Unconfirmed" ? <Icon name="WifiOff" size={14} color={colors.statusWarning} /> : null}
    </View>
    <Text numberOfLines={3} style={{ color: colors.foreground, fontWeight: "600", fontSize: 14, lineHeight: 20 }}>{row.entry.task.title}</Text>
    <View style={{ flexDirection: "row", gap: 7, alignItems: "center" }}><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: laneColor(item.lane, colors) }} /><Text style={{ color: colors.foregroundMuted, fontSize: 12, flex: 1 }}>{item.label}</Text></View>
    {item.lane === "attention" ? <Text numberOfLines={3} style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{item.tab === "Workers" && row.state !== "Unconfirmed" ? "Open the linked conversation to clarify the blocker. No approval is waiting here." : item.tab === "Receipt" ? "Your decision is already saved. Confirm delivery before resuming." : item.label}</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{row.workers.filter(agent => !agent.archivedAt).length} workers{item.running ? ` · ${item.running} active` : ""}</Text>
      {row.queue.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Priority {row.priority}</Text> : null}
      {row.limited ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Partial snapshot</Text> : null}
    </View>
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 9, gap: 7 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Updated {formatDateTime(row.updatedAt)}</Text>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}><Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 13, flex: 1 }}>{item.action}</Text><Icon name="ArrowRight" color={colors.foregroundMuted} size={15} /></View>
    </View>
  </Pressable>;
}

function Lane({ lane, tasks, colors, width, open, loading }: { lane: typeof kanbanLanes[number]; tasks: KanbanTask[]; colors: Colors; width: number; open(key: string): void; loading: boolean }) {
  return <View style={{ width, flex: 1, minHeight: 0, backgroundColor: colors.surface1, borderRadius: 8 }}>
    <View style={{ padding: 13, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Icon name={lane.icon} size={16} color={laneColor(lane.id, colors)} /><Text accessibilityRole="header" style={{ color: colors.foreground, fontWeight: "600", flex: 1 }}>{lane.title}</Text><Text style={{ color: colors.foregroundMuted, fontVariant: ["tabular-nums"] }}>{loading ? "…" : tasks.length}</Text></View>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{lane.description}</Text>
    </View>
    <FlatList data={tasks} keyExtractor={item => item.row.key} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 16 }}
      initialNumToRender={12} maxToRenderPerBatch={12} renderItem={({ item }) => <TaskCard item={item} colors={colors} open={() => open(item.row.key)} />}
      ListEmptyComponent={<View style={{ padding: 24, alignItems: "center", gap: 12 }}><Icon name={loading ? "RefreshCw" : "CircleCheck"} size={24} color={colors.foregroundMuted} /><Text style={{ color: colors.foregroundMuted, textAlign: "center", lineHeight: 21 }}>{loading ? "Reading managed hosts…" : "No matching tasks in this lane."}</Text></View>} />
  </View>;
}

export function Kanban({ theme, host, layout, navigation, params }: PluginScreenProps) {
  const colors = theme.colors;
  const query = useKanbanData(host.id);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(800);
  const [focus, setFocus] = useState<KanbanFocus>("All work");
  const [scope, setScope] = useState(emptyKanbanScope);
  const [filterMenu, setFilterMenu] = useState<ScopeKind | null>(null);
  const [search, setSearch] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const [laneFilter, setLaneFilter] = useState<KanbanLane | "all">("all");
  const [selection, setSelection] = useState<string | null>(null);
  const [notices, setNotices] = useState(false);
  const [intake, setIntake] = useState(false);
  const boardScroll = useRef<ScrollView>(null);
  useEffect(() => {
    if (focuses.includes(params.focus as KanbanFocus)) setFocus(params.focus as KanbanFocus);
    if (kanbanLanes.some(lane => lane.id === params.lane)) setLaneFilter(params.lane as KanbanLane);
    else setLaneFilter("all");
    setSelection(null);
  }, [params.focus, params.lane]);
  const sizing = kanbanLayout(width, layout.compact);
  const scopedTasks = useMemo(() => query.tasks.filter(item => matchesKanbanScope(item, scope)), [query.tasks, scope]);
  const visible = useMemo(() => filterKanban(scopedTasks, "all", "all", search, focus), [scopedTasks, search, focus]);
  const counts = kanbanCounts(query.tasks);
  const filteredCounts = kanbanCounts(filterKanban(scopedTasks, "all", "all", search, "All work"));
  const hosts = [...(query.data?.hosts ?? [])].sort((a, b) => a.label.localeCompare(b.label));
  const filterOptions = kanbanFilterOptions(query.tasks, hosts, scope);
  const unavailable = hosts.filter(remote => remote.error || !remote.snapshot);
  const limited = hosts.filter(remote => remote.snapshot && !remote.snapshot.complete);
  const eligibleLanes = kanbanLanes.filter(lane => showEmpty || visible.some(item => item.lane === lane.id));
  const lanes = eligibleLanes.length ? eligibleLanes : kanbanLanes.filter(lane => lane.id === "attention");
  const chosenLane = lanes.find(lane => lane.id === laneFilter) ?? lanes[0];
  const displayedLanes = sizing.singleLane ? [chosenLane] : laneFilter === "all" ? lanes : [kanbanLanes.find(lane => lane.id === laneFilter)!];
  const selected = query.tasks.find(item => item.row.key === selection);
  const reset = () => { setScope(emptyKanbanScope()); setFilterMenu(null); setSearch(""); setFocus("All work"); setLaneFilter("all"); };
  const refresh = () => { void query.refetch(); };
  return <View onLayout={event => { setWidth(event.nativeEvent.layout.width); setHeight(event.nativeEvent.layout.height); }} style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}>
    {intake && query.data ? <KanbanIntake snapshot={query.data} colors={colors} navigation={navigation} close={() => setIntake(false)} refresh={refresh} openTask={(serverId, taskId) => { setIntake(false); setSelection(`${serverId}:${taskId}`); refresh(); }} /> : selection && selected && query.data ? <KanbanDetail key={selected.row.key} item={selected} snapshot={query.data} colors={colors} compact={sizing.singleLane} height={height} navigation={navigation} close={() => setSelection(null)} refresh={refresh} /> : <>
      {filterMenu && !sizing.singleLane ? <Pressable accessibilityRole="button" accessibilityLabel="Close filter menu" onPress={() => setFilterMenu(null)} style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 2 }} /> : null}
      <View style={{ zIndex: 3, padding: sizing.singleLane ? 12 : 18, gap: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}><Icon name="SquareKanban" size={22} color={colors.foregroundMuted} /><Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 22, fontWeight: "600" }}>Kanban</Text></View>
          <TextInput accessibilityLabel="Search Kanban tasks" placeholder="Search tickets, tasks, workers or blockers" placeholderTextColor={colors.foregroundMuted} value={search} onChangeText={setSearch} style={{ flex: 1, minWidth: sizing.singleLane ? 180 : 260, color: colors.foreground, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 7, padding: 10, minHeight: 42 }} />
          <Text style={{ color: colors.foregroundMuted }}>{query.isPending ? "Loading…" : `${visible.length} tasks`}</Text>
          <CompactLink label="Intake" colors={colors} disabled={!query.data} onPress={() => { setFilterMenu(null); setIntake(true); }} />
          <CompactLink label={query.isFetching ? "Refreshing…" : "Refresh"} colors={colors} disabled={query.isFetching} onPress={refresh} />
        </View>
        <View style={{ zIndex: 10, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {([{ kind: "hosts", title: "Host", icon: "Server", hint: "Select one or more hosts. Changing hosts clears project and workspace selections." },
            { kind: "projects", title: "Project", icon: "FolderKanban", hint: "Projects on the selected hosts. Changing projects clears workspace selections." },
            { kind: "workspaces", title: "Workspace", icon: "FolderGit2", hint: "Workspaces assigned to these tasks. Counts include all stages, before search and lane filters." }] as const).map(filter =>
            <KanbanFilterMenu key={filter.kind} title={filter.title} icon={filter.icon} hint={filter.hint} colors={colors} compact={sizing.singleLane}
              options={filterOptions[filter.kind]} selected={scope[filter.kind]} open={filterMenu === filter.kind}
              onOpenChange={open => setFilterMenu(open ? filter.kind : null)} onChange={ids => { setScope(current => changeKanbanScope(current, filter.kind, ids)); setLaneFilter("all"); }} />)}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {focuses.map(name => <CompactLink key={name} colors={colors} selected={focus === name} label={name === "Needs you" ? `Needs you · ${filteredCounts.needsYou}` : name === "Running" ? `Running · ${filteredCounts.running}` : "All work"} onPress={() => { setFocus(name); setLaneFilter("all"); }} />)}
          <CompactLink label={showEmpty ? "Hide empty lanes" : "Show empty lanes"} colors={colors} onPress={() => setShowEmpty(!showEmpty)} />
          {scope.hosts.length || scope.projects.length || scope.workspaces.length || search || focus !== "All work" || laneFilter !== "all" ? <CompactLink label="Reset filters" colors={colors} onPress={reset} /> : null}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>One card per task · {hosts.length} managed hosts · {counts.plans} plan approvals · {counts.reviews} code reviews</Text>
          {unavailable.length || limited.length || query.data?.warnings.length || counts.unconfirmed ? <CompactLink label={`${unavailable.length} unavailable · ${limited.length} partial · ${counts.unconfirmed} unconfirmed tasks`} colors={colors} expanded={notices} onPress={() => setNotices(!notices)} /> : null}
        </View>
        {notices ? <View style={{ gap: 6 }}>{hosts.filter(remote => remote.error || !remote.snapshot || !remote.snapshot.complete).map(remote => <Text key={remote.serverId} selectable style={{ color: colors.statusWarning, fontSize: 12 }}>{remote.label}: {remote.error ?? remote.snapshot?.warnings.join(" · ") ?? "No snapshot returned"}</Text>)}{query.data?.warnings.map((warning, index) => <Text key={index} style={{ color: colors.statusWarning, fontSize: 12 }}>{warning}</Text>)}<Text style={{ color: colors.statusWarning, fontSize: 12 }}>Unavailable hosts may have more work. Last-known tasks stay visible; unconfirmed counts are not live status.</Text></View> : null}
        {query.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>Refresh failed. Last-known tasks are unconfirmed. {query.error instanceof Error ? query.error.message : String(query.error)}</Text> : null}
        {selection && !selected ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>The selected task is no longer in the returned host records. Choose another task or refresh.</Text> : null}
        <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6 }} showsHorizontalScrollIndicator={false}>
          {!sizing.singleLane ? <CompactLink label="All lanes" selected={laneFilter === "all"} colors={colors} onPress={() => setLaneFilter("all")} /> : null}
          {kanbanLanes.map(lane => <CompactLink key={lane.id} label={`${lane.title} · ${visible.filter(item => item.lane === lane.id).length}`} selected={sizing.singleLane ? chosenLane.id === lane.id : laneFilter === lane.id} colors={colors} onPress={() => { setLaneFilter(lane.id); setShowEmpty(true); boardScroll.current?.scrollTo({ x: 0, animated: false }); }} />)}
        </ScrollView>
      </View>
      {query.isError && !query.data ? <View style={{ padding: 24, gap: 10 }}><Text style={{ color: colors.foreground }}>The board could not load. Check the selected installation's connection and refresh.</Text></View>
        : sizing.singleLane ? <View style={{ flex: 1, minHeight: 0, padding: 12 }}><Lane lane={chosenLane} tasks={visible.filter(item => item.lane === chosenLane.id)} colors={colors} width={sizing.laneWidth} open={setSelection} loading={query.isPending} /></View>
        : <ScrollView ref={boardScroll} horizontal style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 12, flexDirection: "row" }}>
          {displayedLanes.map(lane => <Lane key={lane.id} lane={lane} tasks={visible.filter(item => item.lane === lane.id)} colors={colors} width={sizing.laneWidth} open={setSelection} loading={query.isPending} />)}
        </ScrollView>}
    </>}
  </View>;
}

export function KanbanSidebar(props: PluginSidebarItemProps) {
  const query = useKanbanData(props.host.id);
  const colors = props.theme.colors;
  const counts = kanbanSidebarCounts(query.data, query.tasks, query.now, query.isError);
  const indicators = [
    { key: "running", icon: "CircleDot" as const, count: counts.runningAgents, label: `${counts.runningAgents} running agents across managed hosts, including coordinators`, color: "#3b82f6" },
    { key: "input", icon: "MessageCircle" as const, count: counts.input, label: `${counts.input} tasks need an answer, delivery decision or blocker follow-up`, color: colors.statusWarning },
    { key: "review", icon: "ClipboardCheck" as const, count: counts.ready, label: `${counts.plans} plans and ${counts.reviews} code reviews waiting for your decision; not completed tasks`, color: colors.statusSuccess },
    { key: "hosts", icon: "CloudOff" as const, count: counts.unavailableHosts, label: `${counts.unavailableHosts} hosts unavailable, stale or incomplete; their activity and decisions are excluded`, color: colors.foregroundMuted },
  ];
  const summary = query.isPending ? "Loading Kanban status" : query.isError ? "Could not refresh Kanban. Open the board and refresh the host connections." : indicators.map(item => item.label).join(". ");
  const trailing = <View accessibilityLabel={summary} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
    {query.isPending ? <Text accessibilityLabel="Loading Kanban status" style={{ color: colors.foregroundMuted }}>…</Text> : indicators.filter(item => item.count > 0).map(item => <View key={item.key} accessible accessibilityLabel={item.label} {...(Platform.OS === "web" ? { title: item.label } : {})} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
      {item.key === "running" ? <ActivityIndicator size={12} color={item.color} accessibilityLabel="Agents running" /> : <Icon name={item.icon} size={12} color={item.color} />}
      <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{item.count}</Text>
    </View>)}
    {query.isError && !counts.unavailableHosts ? <View accessible accessibilityLabel={summary} {...(Platform.OS === "web" ? { title: summary } : {})}><Icon name="CloudOff" size={13} color={colors.foregroundMuted} /></View> : null}
  </View>;
  return <View {...(Platform.OS === "web" ? { title: summary } : {})}><SidebarRow icon="SquareKanban" label="Kanban" active={props.currentScreen?.screenId === kanbanScreenId} trailing={trailing} onPress={() => props.openScreen({ screenId: kanbanScreenId })} /></View>;
}

export function registerKanban(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: kanbanScreenId, title: "Kanban", Component: Kanban }),
    client.addSidebarHeaderItem({ id: kanbanScreenId, title: "Kanban", Component: KanbanSidebar }),
    client.addCommandCenterItem({ id: "open-kanban", title: "Open Mission Control Kanban", icon: "SquareKanban", context: "global", keywords: ["board", "tasks", "hosts", "plan", "review"], onSelect: () => client.openScreen({ screenId: kanbanScreenId }) }),
    client.addSlashCommand({ name: "kanban", description: "Open the Mission Control task board across managed hosts", argumentHint: "", context: "workspace", onSubmit: () => client.openScreen({ screenId: kanbanScreenId }) }),
  ];
  return () => removers.forEach(remove => remove());
}
