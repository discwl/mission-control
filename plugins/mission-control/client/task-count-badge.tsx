import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Platform, Text, View } from "react-native";
import type { TaskCounts } from "../shared/task-summary";

export function taskCountLabel(counts: TaskCounts | undefined, unavailable = "Tasks unavailable"): string {
  return counts ? counts.total === 0 ? "No tasks" : `${counts.total} ${counts.total === 1 ? "task" : "tasks"} · ${counts.active} active` : unavailable;
}

export function TaskCountBadge({ counts, unavailable = "Tasks unavailable", colors, small = false, presentation = "inline" }: {
  counts: TaskCounts | undefined;
  unavailable?: string;
  colors: PluginSurfaceProps["theme"]["colors"];
  small?: boolean;
  presentation?: "inline" | "toolbar";
}) {
  const label = taskCountLabel(counts, unavailable);
  if (presentation === "toolbar") return <View accessibilityLabel={label} style={{ minHeight: Platform.OS === "web" ? 32 : 44, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: colors.border, borderRadius: 6, backgroundColor: colors.surface1, flexShrink: 1 }}>
    <Icon name="ListTodo" size={14} color={colors.foregroundMuted} />
    {counts ? <>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>{counts.total}</Text> {counts.total === 1 ? "task" : "tasks"}</Text>
      <View style={{ width: 1, height: 12, backgroundColor: colors.border }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: counts.active ? colors.accent : colors.foregroundMuted }} />
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>{counts.active}</Text> active</Text>
      </View>
    </> : <Text style={{ color: colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>{label}</Text>}
  </View>;
  const color = counts?.active ? colors.accent : colors.foregroundMuted;
  return <View accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "center", gap: 4, minWidth: 0, flexShrink: 1 }}>
    <Icon name="ListTodo" size={small ? 12 : 14} color={color} />
    <Text style={{ color, fontSize: small ? 11 : 12, flexShrink: 1 }}>{label}</Text>
  </View>;
}
