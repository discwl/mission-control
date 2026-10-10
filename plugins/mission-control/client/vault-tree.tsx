import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { listVaultFolder, type VaultEntry } from "../shared/vault";
import { vaultError } from "./vault-editor";

type Props = {
  path: string; serverId: string; selected: string; expanded: Set<string>; depth?: number;
  colors: PluginSurfaceProps["theme"]["colors"]; onSelect: (entry: VaultEntry) => void; onToggle: (path: string) => void;
};
export function VaultTree({ path, serverId, selected, expanded, depth = 0, colors, onSelect, onToggle }: Props) {
  const read = useRpc(listVaultFolder);
  const folder = useQuery({ queryKey: ["mission-control", "vault-folder", serverId, path], queryFn: () => read({ path }), retry: false, staleTime: 15_000 });
  return <View>
    {folder.isPending ? <Text style={{ padding: 10, color: colors.foregroundMuted, fontSize: 12 }}>Loading…</Text> : null}
    {folder.isError ? <Text accessibilityRole="alert" style={{ padding: 10, color: colors.statusDanger, fontSize: 12 }}>{vaultError(folder.error)}</Text> : null}
    {folder.data?.entries.map(entry => <View key={entry.path}>
      <View style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingLeft: Math.min(depth, 8) * 12, backgroundColor: selected === entry.path ? colors.surface2 : undefined, borderRadius: 5 }}>
        {entry.kind === "folder" ? <Pressable accessibilityRole="button" accessibilityLabel={`${expanded.has(entry.path) ? "Collapse" : "Expand"} ${entry.path}`} accessibilityState={{ expanded: expanded.has(entry.path) }} onPress={() => onToggle(entry.path)} style={{ width: 36, height: 44, alignItems: "center", justifyContent: "center" }}><Icon name={expanded.has(entry.path) ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} /></Pressable> : <View style={{ width: 36, alignItems: "center" }}><Icon name={entry.kind === "link" ? "Link" : /\.md$/i.test(entry.name) ? "FileText" : "File"} size={14} color={colors.foregroundMuted} /></View>}
        <Pressable accessibilityRole="button" accessibilityLabel={`Open ${entry.kind} ${entry.path}`} accessibilityState={{ selected: selected === entry.path }} onPress={() => onSelect(entry)} style={{ flex: 1, minHeight: 44, justifyContent: "center", paddingRight: 8 }}><Text numberOfLines={2} style={{ color: selected === entry.path ? colors.foreground : colors.foregroundMuted, fontSize: 12 }}>{entry.name}</Text></Pressable>
        {!entry.manageable ? <View style={{ paddingRight: 6 }}><Icon name="Lock" size={11} color={colors.foregroundMuted} /></View> : null}
      </View>
      {entry.kind === "folder" && expanded.has(entry.path) ? <VaultTree path={entry.path} serverId={serverId} selected={selected} expanded={expanded} depth={depth + 1} colors={colors} onSelect={onSelect} onToggle={onToggle} /> : null}
    </View>)}
    {folder.data?.entries.length === 0 ? <Text style={{ padding: 10, paddingLeft: 16 + Math.min(depth, 8) * 12, color: colors.foregroundMuted, fontSize: 11 }}>Empty folder</Text> : null}
  </View>;
}
