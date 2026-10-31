import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { searchFilterOptions, type FilterOption } from "./kanban-filters-model";

type Colors = PluginSurfaceProps["theme"]["colors"];
export function KanbanFilterMenu({ title, icon, options, selected, onChange, open, onOpenChange, colors, compact, hint }: {
  title: string; icon: string; options: FilterOption[]; selected: string[]; onChange(ids: string[]): void;
  open: boolean; onOpenChange(open: boolean): void; colors: Colors; compact: boolean; hint: string;
}) {
  const [search, setSearch] = useState("");
  const window = useWindowDimensions();
  const listHeight = Math.max(160, Math.min(520, window.height - 360));
  const missing = selected.filter(id => !options.some(option => option.id === id));
  const available = [...options, ...missing.map(id => ({ id, label: "Selection unavailable", detail: id, count: 0 }))];
  const shown = searchFilterOptions(available, search);
  const label = selected.length === 0 ? title : selected.length === 1 ? `${title}: ${available.find(option => option.id === selected[0])?.label ?? "Unavailable"}` : `${title}: ${selected.length}`;
  const close = () => { onOpenChange(false); setSearch(""); };
  const row = (id: string | null, label: string, detail: string, count?: number) => {
    const checked = id === null ? selected.length === 0 : selected.includes(id);
    return <Pressable key={id ?? "all"} accessibilityRole="checkbox" accessibilityLabel={`${label}${detail ? `, ${detail}` : ""}${count === undefined ? "" : `, ${count} tasks`}`} accessibilityState={{ checked }}
      onPress={() => onChange(id === null ? [] : checked ? selected.filter(value => value !== id) : [...selected, id])}
      style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 10, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 9, backgroundColor: pressed || checked ? colors.surface2 : colors.surface1 })}>
      <Icon name={checked ? "SquareCheck" : "Square"} size={16} color={checked ? colors.accent : colors.foregroundMuted} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}><Text style={{ color: colors.foreground, fontSize: 13 }}>{label}</Text>{detail ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{detail}</Text> : null}</View>
      {count === undefined ? null : <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{count}</Text>}
    </Pressable>;
  };
  const body = <>
    <View style={{ padding: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <TextInput autoFocus accessibilityLabel={`Search ${title.toLowerCase()} options`} placeholder={`Search ${title.toLowerCase()}…`} placeholderTextColor={colors.foregroundMuted} value={search} onChangeText={setSearch}
        onKeyPress={event => { if (event.nativeEvent.key === "Escape") close(); }}
        style={{ color: colors.foreground, backgroundColor: colors.surface0, borderWidth: 1, borderColor: colors.border, borderRadius: 5, padding: 9, minHeight: 40 }} />
    </View>
    <ScrollView style={compact ? { flex: 1, minHeight: 0 } : { maxHeight: listHeight }} keyboardShouldPersistTaps="handled">
      {row(null, `All ${title.toLowerCase()}s`, "No restriction")}
      {shown.map(option => row(option.id, option.label, option.detail, option.count))}
      {!shown.length ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, padding: 12 }}>{search.trim() ? "No matching options. Clear the search or change the parent filter." : "No managed tasks returned for this selection. Projects and agent chats may still exist on the host; this menu currently lists only task-linked work."}</Text> : null}
    </ScrollView>
    <View style={{ padding: 10, gap: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{hint}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Done selecting ${title.toLowerCase()}s`} onPress={close} style={{ alignSelf: "flex-end", minHeight: 40, justifyContent: "center", paddingHorizontal: 12, borderRadius: 5, backgroundColor: colors.surface2 }}><Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 13 }}>Done</Text></Pressable>
    </View>
  </>;
  return <View style={{ zIndex: open ? 30 : 1, maxWidth: compact ? "100%" : 180 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Filter ${title.toLowerCase()}s: ${selected.length ? label : "All"}`} accessibilityState={{ expanded: open }}
      onPress={() => { setSearch(""); onOpenChange(!open); }}
      style={({ pressed }) => ({ minHeight: 38, maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 10, borderWidth: 1, borderColor: selected.length || open ? colors.accent : colors.border, borderRadius: 6, backgroundColor: pressed || open ? colors.surface2 : colors.surface0 })}>
      <Icon name={icon} size={15} color={colors.foregroundMuted} /><Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>{label}</Text><Icon name="ChevronDown" size={13} color={colors.foregroundMuted} />
    </Pressable>
    {compact ? <Modal title={`Filter ${title.toLowerCase()}s`} open={open} onOpenChange={value => { if (!value) close(); }}><Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0, flex: 1 }} style={{ backgroundColor: colors.surface1 }}>{body}</Modal.Content></Modal>
      : open ? <View style={{ position: "absolute", top: 44, left: 0, width: 310, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: "hidden" }}>{body}</View> : null}
  </View>;
}
