import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { TaskRecord } from "../shared/tasks";
import { CompactLink } from "./compact-link";
import { CopyTaskId } from "./copy-task-id";
import { AppModal as Modal } from "./app-modal";
import { TaskFlowDetail } from "./task-flow";

type Colors = PluginSurfaceProps["theme"]["colors"];
export function LinkedTasks({ tasks, colors, serverId, workspaceId, hostLabel, online, openAgent, viewAll }: { tasks: TaskRecord[]; colors: Colors; serverId: string; workspaceId: string; hostLabel: string; online: boolean; openAgent: (id: string) => void; viewAll: () => void }) {
  const [showCompleted, setShowCompleted] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const active = tasks.filter(task => task.status !== "delivered" && task.status !== "closed");
  const completed = tasks.filter(task => task.status === "delivered" || task.status === "closed");
  const selected = tasks.find(task => task.taskId === selectedId);
  const row = (task: TaskRecord) => <Pressable key={task.taskId} accessibilityRole="button" accessibilityLabel={`Task details for ${task.title}`} onPress={() => setSelectedId(task.taskId)}
    style={({ pressed }) => ({ minHeight: 44, paddingVertical: 9, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: pressed ? colors.surface2 : "transparent" })}>
    <View style={{ flex: 1, gap: 3 }}>
      <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: 13, lineHeight: 19, fontWeight: "600" }}>{task.title}</Text>
      <Text style={{ color: task.status === "blocked" ? colors.statusWarning : colors.foregroundMuted, fontSize: 11 }}>{task.status.replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase())}</Text>
    </View>
    <CopyTaskId taskId={task.taskId} colors={colors} />
    <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />
  </Pressable>;
  return <View style={{ gap: 6 }}>
    <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>Linked tasks · {active.length} active</Text>
    {!active.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No active linked tasks.</Text> : active.slice(0, 5).map(row)}
    {active.length > 5 ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Showing 5 of {active.length} active tasks</Text> : null}
    {completed.length ? <CompactLink label={`Completed tasks · ${completed.length}`} expanded={showCompleted} colors={colors} onPress={() => setShowCompleted(!showCompleted)} /> : null}
    {showCompleted ? completed.slice(0, 5).map(row) : null}
    {showCompleted && completed.length > 5 ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Showing 5 of {completed.length} completed tasks</Text> : null}
    <CompactLink label="View all tasks" icon="ArrowUpRight" colors={colors} onPress={viewAll} />
    <Modal colors={colors} icon={selected ? <CopyTaskId key={selected.taskId} taskId={selected.taskId} colors={colors} /> : undefined} title={selected?.title ?? "Task details"} open={Boolean(selected)} onOpenChange={open => { if (!open) setSelectedId(null); }}>
      <Modal.Content>{selected ? <TaskFlowDetail key={selected.taskId} task={selected} binding={{ serverId, workspaceId, taskId: selected.taskId }} online={online} colors={colors} hostLabel={hostLabel} openAgent={openAgent} /> : null}</Modal.Content>
    </Modal>
  </View>;
}
