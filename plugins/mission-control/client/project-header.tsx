import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { formatDateTime } from "./date-time";
import { describeProjectSummary, type ProjectAgentSummary } from "./project-summary";
import { ProviderIcon } from "./provider-icons";

type Colors = PluginSurfaceProps["theme"]["colors"];
const MAX_PROVIDERS = 4;

function Count({ value, label, color, icon, colors }: { value: number; label: string; color: string; icon?: string; colors: Colors }) {
  if (value === 0) return null;
  return <View accessible accessibilityLabel={`${value} ${label}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
    {icon ? <Icon name={icon} size={12} color={color} /> : <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />}
    <Text style={{ color: colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>{value}</Text>
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
  </View>;
}

/** Collapsible project block header with a compact agent summary. */
export function ProjectHeader({ name, collapsed, onToggle, workspaceCount, summary, tasks, tasksLabel, colors }: {
  name: string; collapsed: boolean; onToggle: () => void; workspaceCount: number;
  summary: ProjectAgentSummary; tasks: ReactNode; tasksLabel: string; colors: Colors;
}) {
  const extraProviders = summary.providers.length - MAX_PROVIDERS;
  // The button label replaces its children for screen readers, so it carries the whole summary.
  const label = [
    `${name}, ${workspaceCount} ${workspaceCount === 1 ? "workspace" : "workspaces"}`,
    describeProjectSummary(summary),
    summary.lastActivityAt ? `last activity ${formatDateTime(summary.lastActivityAt)}` : null,
    tasksLabel,
  ].filter(Boolean).join(", ");
  return <Pressable accessibilityRole="button" accessibilityState={{ expanded: !collapsed }} accessibilityLabel={label} accessibilityHint={collapsed ? "Expands this project" : "Collapses this project"}
    onPress={onToggle}
    style={({ pressed }) => ({ gap: 6, paddingVertical: 9, paddingHorizontal: 10, backgroundColor: colors.surface2, borderRadius: 7, borderLeftWidth: 3, borderLeftColor: colors.accent, opacity: pressed ? 0.85 : 1 })}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
      <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} size={16} color={colors.foregroundMuted} />
      <Icon name={collapsed ? "Folder" : "FolderOpen"} size={17} color={colors.accent} />
      <Text accessibilityRole="header" numberOfLines={1} style={{ color: colors.foreground, fontSize: 16, fontWeight: "700", flex: 1, minWidth: 0 }}>{name}</Text>
      <View style={{ alignItems: "flex-end", gap: 4, maxWidth: "50%" }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{workspaceCount} {workspaceCount === 1 ? "workspace" : "workspaces"}</Text>
        {tasks}
      </View>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 4, paddingLeft: 23 }}>
      {summary.total === 0 ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No agents</Text> : <>
        <Count value={summary.running} label="running" color={colors.statusSuccess} colors={colors} />
        <Count value={summary.idle} label="idle" color={colors.foregroundMuted} colors={colors} />
        <Count value={summary.needsYou} label="need you" color={colors.statusWarning} icon="CircleAlert" colors={colors} />
        <Count value={summary.errored} label="errored" color={colors.statusDanger} icon="CircleX" colors={colors} />
        {summary.running + summary.idle + summary.needsYou + summary.errored === 0 ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{summary.total} closed</Text> : null}
      </>}
      {summary.providers.length > 0 ? <View accessible accessibilityLabel={`Providers: ${summary.providers.join(", ")}`} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        {summary.providers.slice(0, MAX_PROVIDERS).map(provider => <ProviderIcon key={provider} provider={provider} color={colors.foregroundMuted} size={14} />)}
        {extraProviders > 0 ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>+{extraProviders}</Text> : null}
      </View> : null}
      {summary.lastActivityAt ? <View accessible accessibilityLabel={`Last activity ${formatDateTime(summary.lastActivityAt)}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Icon name="Clock" size={12} color={colors.foregroundMuted} />
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{formatDateTime(summary.lastActivityAt)}</Text>
      </View> : null}
    </View>
  </Pressable>;
}
