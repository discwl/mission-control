import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
type Colors = PluginSurfaceProps["theme"]["colors"];
import { CompactLink } from "./compact-link";
import { findCopy } from "./host-bridge";
import { readClientStorage, writeClientStorage } from "./web";

const key = "mission-control:kanban-origin:v1";
export function readKanbanOrigin(): string | null {
  const value = readClientStorage(key) ?? (globalThis as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && /^srv_[a-zA-Z0-9_-]+$/.test(value) ? value : null;
}
/** Remember the board installation, not the remote worker's host. Roll back failed navigation. */
export function navigateFromKanban(serverId: string, navigate: () => void) {
  const previous = readKanbanOrigin();
  const memory = globalThis as unknown as Record<string, unknown>;
  memory[key] = serverId;
  writeClientStorage(key, serverId);
  try { navigate(); }
  catch (error) { memory[key] = previous; writeClientStorage(key, previous); throw error; }
}
export function returnToKanban(serverId: string) {
  const result = findCopy(serverId);
  if (!("copy" in result) || !result.copy.openKanban) throw new Error("The original board's Mission Control connection is unavailable or needs an update. Select its host in Paseo, then open Kanban.");
  result.copy.openKanban();
}
export function KanbanOrigin({ serverId, colors }: { serverId: string; colors: Colors }) {
  const origin = readKanbanOrigin();
  const [error, setError] = useState<string | null>(null);
  return <View style={{ gap: 6 }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Board scope: the selected host's managed fleet. Sidebar counts cover this fleet before board filters.</Text>
    {origin && origin !== serverId ? <>
      <Text style={{ color: colors.statusWarning }}>You opened a different host's board after leaving Kanban. Its tasks and counts may differ.</Text>
      <CompactLink label="Return to original Kanban" icon="ArrowLeft" colors={colors} onPress={() => { try { returnToKanban(origin); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }} />
    </> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>{error}</Text> : null}
  </View>;
}
