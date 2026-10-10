import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { CompactLink } from "./compact-link";

type Colors = PluginSurfaceProps["theme"]["colors"];
export type WorkspaceShowFilter = "all" | "active" | "attention" | "tasks" | "active_tasks";

const showOptions: { label: string; value: WorkspaceShowFilter }[] = [
  { label: "All workspaces", value: "all" },
  { label: "Running agent", value: "active" },
  { label: "Needs attention", value: "attention" },
  { label: "Has tasks", value: "tasks" },
  { label: "Has active tasks", value: "active_tasks" },
];

function FilterPill({ text, selected, onPress, colors }: { text: string; selected: boolean; onPress: () => void; colors: Colors }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={text} accessibilityState={{ selected }} onPress={onPress}
    style={{ minHeight: 36, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1, borderColor: selected ? colors.accent : colors.border, backgroundColor: selected ? colors.surface2 : colors.surface1, justifyContent: "center" }}>
    <Text style={{ color: selected ? colors.accent : colors.foregroundMuted, fontSize: 12, fontWeight: selected ? "600" : "400" }}>{text}</Text>
  </Pressable>;
}

/**
 * Search, single-choice filter pills, and a project checklist that stays open while selecting.
 * showFilters limits the Show choices, for views that can't count a host's tasks.
 */
export function WorkspaceFilterBar({ colors, search, onSearch, show, onShow, showFilters, label, labels, onLabel, projectIds, projects, onProjects, shown, total, actions }: {
  colors: Colors;
  search: string; onSearch: (value: string) => void;
  show: WorkspaceShowFilter; onShow: (value: WorkspaceShowFilter) => void; showFilters?: readonly WorkspaceShowFilter[];
  label: string; labels: readonly string[]; onLabel: (value: string) => void;
  projectIds: readonly string[]; projects: readonly { id: string; name: string }[] | null; onProjects: (value: string[]) => void;
  shown: number; total: number;
  actions?: ReactNode;
}) {
  const selectedLabel = labels.find(name => name.toLowerCase() === label.toLowerCase()) ?? "all";
  const filtered = search.trim() !== "" || show !== "all" || label !== "all" || projectIds.length > 0;
  const [projectsOpen, setProjectsOpen] = useState(false);
  const projectTitle = projectIds.length === 0 ? "All projects" : projectIds.length === 1 ? projects?.find(project => project.id === projectIds[0])?.name ?? "1 project" : `${projectIds.length} projects`;
  const filterRow = (title: string, children: ReactNode) => <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
    <Text style={{ width: 44, paddingTop: 10, color: colors.foreground, fontSize: 12, fontWeight: "600" }}>{title}</Text>
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{children}</View>
  </View>;
  const projectOption = (id: string | null, name: string) => {
    const checked = id === null ? projectIds.length === 0 : projectIds.includes(id);
    return <Pressable key={id ?? "all-projects"} accessibilityRole="checkbox" accessibilityLabel={name} accessibilityState={{ checked }}
      onPress={() => onProjects(id === null ? [] : checked ? projectIds.filter(value => value !== id) : [...projectIds, id])}
      style={{ flexDirection: "row", alignItems: "center", gap: 9, minHeight: 44, paddingHorizontal: 10, backgroundColor: checked ? colors.surface2 : undefined, borderRadius: 6 }}>
      <Icon name={checked ? "SquareCheck" : "Square"} size={16} color={checked ? colors.accent : colors.foregroundMuted} />
      <Text style={{ flex: 1, color: colors.foreground, fontSize: 13 }}>{name}</Text>
    </Pressable>;
  };
  return <View style={{ gap: 8 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.surface0, borderColor: colors.border, borderWidth: 1, borderRadius: 7, paddingLeft: 9 }}>
      <Icon name="Search" size={15} color={colors.foregroundMuted} />
      <TextInput accessibilityLabel="Filter workspaces" placeholder="Find a workspace or project" placeholderTextColor={colors.foregroundMuted}
        value={search} onChangeText={onSearch} style={{ flex: 1, minWidth: 0, color: colors.foreground, paddingVertical: 8, fontSize: 13 }} />
      {search ? <Pressable accessibilityRole="button" accessibilityLabel="Clear workspace search" onPress={() => onSearch("")} style={{ width: 44, height: 40, alignItems: "center", justifyContent: "center" }}>
        <Icon name="X" size={15} color={colors.foregroundMuted} />
      </Pressable> : null}
    </View>
    {filterRow("Show", showOptions.filter(option => !showFilters || showFilters.includes(option.value)).map(option => <FilterPill key={option.value} text={option.label} selected={show === option.value} onPress={() => onShow(option.value)} colors={colors} />))}
    {filterRow("Label", [{ label: "All labels", value: "all" }, ...labels.map(name => ({ label: name, value: name }))].map(option =>
      <FilterPill key={option.value} text={option.label} selected={selectedLabel === option.value} onPress={() => onLabel(option.value)} colors={colors} />))}
    {projects ? filterRow("Project", <View style={{ width: 320, maxWidth: "100%", gap: 5 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Filter projects: ${projectTitle}`} accessibilityState={{ expanded: projectsOpen }} onPress={() => setProjectsOpen(open => !open)}
        style={{ alignSelf: "flex-start", maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1, borderColor: projectIds.length ? colors.accent : colors.border }}>
        <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: 12 }}>{projectTitle}</Text>
        <Icon name={projectsOpen ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foregroundMuted} />
      </Pressable>
      {projectsOpen ? <View style={{ borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 5, backgroundColor: colors.surface0 }}>
        <ScrollView nestedScrollEnabled style={{ maxHeight: 240 }} keyboardShouldPersistTaps="handled">
          {projectOption(null, "All projects")}
          {projects.map(project => projectOption(project.id, project.name))}
        </ScrollView>
        <View style={{ alignItems: "flex-end", borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 4 }}>
          <CompactLink label="Done selecting projects" colors={colors} onPress={() => setProjectsOpen(false)} />
        </View>
      </View> : null}
    </View>) : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 12, flexGrow: 1 }}>{shown} of {total} {total === 1 ? "workspace" : "workspaces"}</Text>
      {filtered ? <CompactLink label="Clear filters" icon="X" colors={colors} onPress={() => { onSearch(""); onShow("all"); onLabel("all"); onProjects([]); setProjectsOpen(false); }} /> : null}
      {actions}
    </View>
  </View>;
}