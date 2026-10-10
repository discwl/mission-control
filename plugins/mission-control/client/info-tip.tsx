import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

/** Hover/focus on desktop; tap to pin or dismiss on touch devices. */
export function InfoTip({ label, text, colors, containerWidth }: { label: string; text: string; colors: PluginSurfaceProps["theme"]["colors"]; containerWidth?: number }) {
  const [anchorOffset, setAnchorOffset] = useState(0);
  const boundedWidth = containerWidth && containerWidth > 0 ? Math.min(320, containerWidth) : null;
  const tooltipPosition = boundedWidth === null
    ? { right: 0, width: 220 }
    : { left: Math.max(-anchorOffset, Math.min(0, containerWidth! - anchorOffset - boundedWidth)), width: boundedWidth };
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || focused || pinned;
  return <View onLayout={event => setAnchorOffset(event.nativeEvent.layout.x)} style={{ position: "relative", zIndex: open ? 10 : 0 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={text} accessibilityState={{ expanded: open }}
      onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); setPinned(false); }}
      onPress={() => { setPinned(!pinned); setFocused(false); }}
      style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
      <Icon name="Info" size={15} color={colors.foregroundMuted} />
    </Pressable>
    {open ? <View pointerEvents="none" style={{ position: "absolute", ...tooltipPosition, top: 42, padding: 12, borderRadius: 7, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2, zIndex: 10 }}><Text style={{ color: colors.foreground, fontSize: 12, lineHeight: 19 }}>{text}</Text></View> : null}
  </View>;
}
