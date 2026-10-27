import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePageState } from "./page-state";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { CompactLink } from "./compact-link";

export type QueueItem = { key: string; title: string; next: string; content: ReactNode };
// Keep the current request selected through a refresh. A disappearing request must
// never replace the controls under the user's pointer with another approval.
export function queuePosition(items: readonly { key: string }[], selected: string | null) {
  const index = selected === null ? 0 : items.findIndex(item => item.key === selected);
  return { index, current: items[index], next: items[index + 1] ?? (index < 0 ? items[0] : undefined) };
}
export function DecisionQueue({ items, colors, nextTask, memoryKey }: { items: QueueItem[]; colors: PluginSurfaceProps["theme"]["colors"]; nextTask?: () => void; memoryKey: string }) {
  const [selected, setSelected] = usePageState<string | null>(memoryKey, () => items[0]?.key ?? null);
  useEffect(() => { if (selected === null && items[0]) setSelected(items[0].key); }, [selected, items[0]?.key]);
  const { index, current, next } = queuePosition(items, selected);
  const item = current ? items[index] : undefined;
  return <View style={{ gap: 12 }}>
    <View style={{ backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 12, gap: 8 }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontWeight: "700" }}>{item ? `${item.title} · ${index + 1} of ${items.length} waiting here` : "No request selected"}</Text>
      <Text style={{ color: colors.foregroundMuted }}>{item?.next ?? (selected ? "This request is no longer waiting. Choose the next decision when you are ready." : "There are no decisions waiting in this task.")}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {index > 0 ? <CompactLink label="Previous decision" colors={colors} onPress={() => setSelected(items[index - 1].key)} /> : null}
        {next ? <CompactLink label="Next decision" colors={colors} onPress={() => setSelected(next.key)} /> : nextTask ? <CompactLink label="Next task needing you" colors={colors} onPress={nextTask} /> : null}
      </View>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Moving through the queue never approves or sends anything. Saved decision notes stay with their request.</Text>
    </View>
    {item ? <View key={item.key}>{item.content}</View> : null}
  </View>;
}
