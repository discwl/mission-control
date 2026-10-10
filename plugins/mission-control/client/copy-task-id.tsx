import { useEffect, useRef, useState } from "react";
import { Platform, Pressable } from "react-native";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

type Colors = PluginSurfaceProps["theme"]["colors"];
export function CopyTaskId({ taskId, colors }: { taskId: string; colors: Colors }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const toast = useToast();
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    generation.current++;
    setCopied(false); setBusy(false);
    return () => { generation.current++; if (timer.current) clearTimeout(timer.current); };
  }, [taskId]);
  async function copy() {
    const current = generation.current;
    setBusy(true);
    try {
      await copyText(taskId);
      if (current !== generation.current) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      if (current === generation.current) toast.error("Could not copy task ID. Try again.");
    } finally { if (current === generation.current) setBusy(false); }
  }
  const label = copied ? "Task ID copied" : "Copy task ID";
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: busy }} disabled={busy}
    {...(Platform.OS === "web" ? { title: label } : {})}
    onPress={event => { event.stopPropagation(); void copy(); }}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
    style={({ pressed }) => ({ width: Platform.OS === "web" ? 32 : 44, height: Platform.OS === "web" ? 32 : 44, alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: 6, borderColor: focused ? colors.accent : colors.border, backgroundColor: pressed || hovered ? colors.surface2 : "transparent", flexShrink: 0, opacity: busy ? 0.5 : 1 })}>
    <Icon name={copied ? "Check" : "Copy"} size={14} color={copied ? colors.statusSuccess : colors.foregroundMuted} />
  </Pressable>;
}
