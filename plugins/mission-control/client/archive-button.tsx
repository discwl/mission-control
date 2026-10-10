import { getPaseoClient, useHosts, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { AppModal as Modal } from "./app-modal";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { performResourceAction, type ResourceTarget } from "./resource-actions";

type Colors = PluginSurfaceProps["theme"]["colors"];

export function ArchiveButton({ resource, colors, disabled, onComplete }: {
  resource: ResourceTarget; colors: Colors; disabled?: boolean; onComplete?: (target: ResourceTarget) => void;
}) {
  const [target, setTarget] = useState<ResourceTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [showTip, setShowTip] = useState(false);
  const agentHint = "Archive agent: removes it from the active list and stops its session, including running work.";
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const queryClient = useQueryClient();
  const toast = useToast();
  const hosts = useHosts();
  const online = !!target && hosts.some(host => host.serverId === target.serverId && host.status === "online");
  const label = resource.kind === "terminal" ? "Close terminal" : `Archive ${resource.kind}`;
  const action = target?.kind === "terminal" ? "Close terminal" : `Archive ${target?.kind ?? "workspace"}`;

  async function confirm() {
    if (!target || !online || lock.current) return;
    const selected = target; // Freeze both host and resource IDs before awaiting.
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await performResourceAction(getPaseoClient(selected.serverId), selected);
      setTarget(null);
      toast.show(selected.kind === "terminal" ? "Terminal closed" : `${selected.kind === "workspace" ? "Workspace" : "Agent"} archived`, { variant: "success" });
      onComplete?.(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      // An archive can stop some resources before another cleanup step fails.
      void queryClient.invalidateQueries({ queryKey: ["mission-control", "roster", selected.serverId] });
      void queryClient.invalidateQueries({ queryKey: ["mission-control", "terminals", selected.serverId] });
      lock.current = false;
      setBusy(false);
    }
  }

  return <>
    <View style={{ position: "relative", width: resource.kind === "agent" ? 44 : undefined, zIndex: showTip ? 10 : 0 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${resource.name} on ${resource.hostLabel}`} accessibilityHint={resource.kind === "agent" ? agentHint : undefined} disabled={disabled || busy}
        onHoverIn={() => { if (resource.kind === "agent") setShowTip(true); }} onHoverOut={() => setShowTip(false)}
        onFocus={() => { if (resource.kind === "agent") setShowTip(true); }} onBlur={() => setShowTip(false)}
        onPress={() => { setShowTip(false); setError(null); setTarget({ ...resource }); }}
        style={{ minHeight: 44, minWidth: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 7, opacity: disabled ? 0.4 : 1 }}>
        <Icon name={resource.kind === "terminal" ? "X" : "Archive"} size={15} color={colors.foregroundMuted} />
        {resource.kind !== "agent" ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{label}</Text> : null}
      </Pressable>
      {showTip && resource.kind === "agent" ? <View pointerEvents="none" style={{ position: "absolute", right: 0, bottom: 44, width: 220, padding: 12, borderRadius: 7, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2, zIndex: 10 }}>
        <Text style={{ color: colors.foreground, fontSize: 12, lineHeight: 19 }}>{agentHint}</Text>
      </View> : null}
    </View>
    <Modal colors={colors} title={`${action}?`} open={target !== null} onOpenChange={open => { if (!open && !lock.current) setTarget(null); }}>
      <Modal.Content>
        <View style={{ gap: 12 }}>
          <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600" }}>{target?.name}</Text>
          <Text style={{ color: colors.foregroundMuted }}>Host: {target?.hostLabel}</Text>
          <Text style={{ color: colors.foreground }}>
            {target?.kind === "workspace" ? "Paseo will archive this workspace, close its agents and terminals, and run its cleanup. A managed worktree may be removed. Resolve any uncommitted work before continuing. Dev-vault tasks and documents are kept."
              : target?.kind === "agent" ? "This archives the agent and stops its session, including any work currently running. Its workspace and dev-vault records are kept."
              : "This ends the terminal session and stops its running command. The session cannot be resumed after closing."}
          </Text>
          {!online ? <Text style={{ color: colors.statusWarning }}>Reconnect this host to continue.</Text> : null}
          {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{error}</Text> : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 10 }}>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => setTarget(null)} style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: "center" }}><Text style={{ color: colors.foreground }}>Cancel</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Confirm ${action.toLowerCase()}`} disabled={busy || !online} onPress={() => void confirm()}
              style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: colors.statusDanger, opacity: busy || !online ? 0.5 : 1 }}>
              <Text style={{ color: colors.statusDanger, fontWeight: "600" }}>{busy ? "Working…" : action}</Text>
            </Pressable>
          </View>
        </View>
      </Modal.Content>
    </Modal>
  </>;
}
