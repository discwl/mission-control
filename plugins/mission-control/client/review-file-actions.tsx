import { useRpc } from "./host-rpc";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { copyText, Icon } from "@getpaseo/plugin/client/react-native";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { AppModal } from "./app-modal";
import { discardReviewChanges, prepareReviewDiscard, resolveReviewItemPath, revealReviewItem } from "../shared/review";
import { bindReviewContextMenu } from "./web";
import type { Colors } from "./review-ui";

export type ReviewItemTarget = { path: string; directory: boolean; deleted?: boolean };
export function ReviewItemActions({ children, target, colors, onOpen }: { children: ReactNode; target: ReviewItemTarget; colors: Colors; onOpen: (target: ReviewItemTarget) => void }) {
  const element = useRef<View>(null);
  useEffect(() => Platform.OS === "web" ? bindReviewContextMenu(element.current, () => onOpen(target)) : undefined, [onOpen, target.path, target.directory]);
  return <View ref={element} style={{ flexDirection: "row", alignItems: "center" }}>
    <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    <Pressable accessibilityRole="button" accessibilityLabel={`Actions for ${target.directory ? "folder" : "file"} ${target.path}`} onPress={() => onOpen(target)} onLongPress={() => onOpen(target)}
      style={{ minWidth: 36, minHeight: 44, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 18 }}>⋯</Text>
    </Pressable>
  </View>;
}

export function ReviewFileMenu({ target, serverId, workspaceId, online, colors, onClose, onOpenFile, onDiscarded }: {
  target: ReviewItemTarget; serverId: string; workspaceId: string; online: boolean; colors: Colors;
  onClose: () => void; onOpenFile: (path: string) => void; onDiscarded: () => void;
}) {
  const prepare = useRpc(prepareReviewDiscard), discard = useRpc(discardReviewChanges), reveal = useRpc(revealReviewItem);
  const resolvePath = useRpc(resolveReviewItemPath);
  const [copied, setCopied] = useState<"path" | "relative" | null>(null);
  const [hovered, setHovered] = useState<string | null>(null), [focused, setFocused] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ paths: string[]; removePaths: string[]; token: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const pending = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const input = { serverId, workspaceId, ...target };
  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setCopied(null);
    try { await action(); }
    catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  async function copyPath(relative: boolean) {
    await run(async () => {
      const path = relative ? target.path : (await resolvePath(input)).path;
      if (!active.current) return;
      try { await copyText(path); }
      catch { throw new Error("Could not copy the path. Try again."); }
      if (active.current) setCopied(relative ? "relative" : "path");
    });
  }
  const parts = target.path.replace(/\\/g, "/").replace(/\/$/, "").split("/");
  const name = parts.pop() || target.path, parent = parts.join("/") || "Repository root";
  const item = (label: string, icon: ComponentProps<typeof Icon>["name"], hint: string, action: () => void, options: { danger?: boolean; local?: boolean } = {}) => {
    const disabled = busy || (!online && !options.local);
    const done = (label === "Copy path" && copied === "path") || (label === "Copy relative path" && copied === "relative");
    return <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint || undefined} accessibilityState={{ disabled }} disabled={disabled}
      onPress={action} onHoverIn={() => setHovered(label)} onHoverOut={() => setHovered(null)} onFocus={() => setFocused(label)} onBlur={() => setFocused(null)}
      style={({ pressed }) => ({ minHeight: hint ? 56 : 44, paddingHorizontal: 12, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 8, borderWidth: 1, borderColor: focused === label ? colors.accent : "transparent", backgroundColor: pressed || hovered === label ? colors.surface2 : "transparent", opacity: disabled ? 0.45 : 1 })}>
      <Icon name={done ? "Check" : icon} size={18} color={done ? colors.statusSuccess : options.danger ? colors.statusDanger : colors.foregroundMuted} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={{ color: options.danger ? colors.statusDanger : colors.foreground, fontSize: 14, fontWeight: "600", lineHeight: 20 }}>{label}</Text>
        {hint ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{hint}</Text> : null}
      </View>
    </Pressable>;
  };
  const sectionLabel = (label: string) => <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1, paddingHorizontal: 12, paddingTop: 4 }}>{label}</Text>;
  return <AppModal open title={plan ? "Discard changes" : target.directory ? "Folder actions" : "File actions"} colors={colors} maxWidth={520} onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <AppModal.Content contentContainerStyle={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, padding: 14, backgroundColor: colors.surface2, borderRadius: 10 }}>
          <View style={{ paddingTop: 2 }}><Icon name={target.directory ? "Folder" : "File"} size={22} color={colors.accent} /></View>
          <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
            <Text selectable style={{ color: colors.foreground, fontWeight: "700", fontSize: 16, lineHeight: 22 }}>{name}</Text>
            <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{parent}</Text>
            {target.deleted ? <Text style={{ color: colors.statusWarning, fontSize: 11 }}>Deleted file</Text> : null}
          </View>
        </View>
        {!plan ? <>
          <View style={{ gap: 2 }}>
            {sectionLabel("OPEN")}
            {!target.directory && !target.deleted ? item("Preview file", "FileText", "View the working file in a preview dialog", () => { onOpenFile(target.path); onClose(); }) : null}
            {item(target.directory ? "Open folder in Windows Explorer" : "Reveal in Windows Explorer", "FolderOpen", "Open on the workspace host", () => void run(async () => { await reveal(input); if (active.current) onClose(); }))}
          </View>
          <View style={{ height: 1, backgroundColor: colors.border }} />
          <View style={{ gap: 2 }}>
            {sectionLabel("COPY")}
            {item("Copy path", "Copy", "Full path on the workspace host", () => void copyPath(false))}
            {item("Copy relative path", "Link", "Path from the repository root", () => void copyPath(true), { local: true })}
          </View>
          <View style={{ height: 1, backgroundColor: colors.border }} />
          {item("Discard changes…", "RotateCcw", "Review the affected files before discarding", () => void run(async () => { const result = await prepare(input); if (active.current) setPlan(result); }), { danger: true })}
        </> : <>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18, paddingHorizontal: 12 }}>Restore staged and unstaged changes to the last commit. {plan.removePaths.length ? `${plan.removePaths.length} new file(s) will be permanently deleted. ` : ""}Committed changes stay intact.</Text>
          <ScrollView style={{ flexGrow: 0, maxHeight: 220, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }} contentContainerStyle={{ padding: 12, gap: 8 }}>
            {plan.paths.map(path => <Text key={path} selectable style={{ color: colors.foreground, fontSize: 12 }}>{plan.removePaths.includes(path) ? "Delete: " : "Restore: "}{path}</Text>)}
          </ScrollView>
          {item(`Discard ${plan.paths.length} file${plan.paths.length === 1 ? "" : "s"}`, "Trash2", "This cannot be undone", () => void run(async () => {
            await discard({ ...input, token: plan.token });
            if (active.current) { onDiscarded(); onClose(); }
          }), { danger: true })}
        </>}
        {busy ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, paddingHorizontal: 12, fontSize: 12 }}>Working…</Text> : null}
        {copied ? <Text accessibilityLiveRegion="polite" style={{ color: colors.statusSuccess, paddingHorizontal: 12, fontSize: 12 }}>{copied === "relative" ? "Relative path copied" : "Path copied"}</Text> : null}
        {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 18, paddingHorizontal: 12 }}>{error}</Text> : null}
        {!online ? <Text style={{ color: colors.statusWarning, fontSize: 12, paddingHorizontal: 12 }}>Host offline. You can still copy the relative path.</Text> : null}
        <View style={{ alignItems: "flex-end", borderTopWidth: 1, borderColor: colors.border, paddingTop: 8 }}>
          {item(plan ? "Cancel" : "Close", "X", "", onClose, { local: true })}
        </View>
      </AppModal.Content>
  </AppModal>;
}
