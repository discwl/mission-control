import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState, type ComponentProps } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { openExternalUrl, type PluginSurfaceProps } from "@getpaseo/plugin/client";

type Colors = PluginSurfaceProps["theme"]["colors"];
type IconName = ComponentProps<typeof Icon>["name"];

function actionIcon(label: string, expanded?: boolean): IconName {
  if (expanded !== undefined) return expanded ? "ChevronUp" : "ChevronDown";
  if (/^(refresh|reload|check)/i.test(label)) return "RefreshCw";
  if (/^←|^back|^all workspaces/i.test(label)) return "ArrowLeft";
  if (/^open|^view|^review changes/i.test(label)) return "ArrowUpRight";
  if (/^copy/i.test(label)) return "Copy";
  if (/^customize|^change|^set up/i.test(label)) return "Settings2";
  if (/^expand/i.test(label)) return "ChevronsDown";
  if (/^collapse/i.test(label)) return "ChevronsUp";
  if (/^hide/i.test(label)) return "ChevronUp";
  if (/^show|^browse/i.test(label)) return "ChevronDown";
  return "ChevronRight";
}

export function CompactLink({ label, onPress, colors, disabled = false, tone, expanded, selected, accessibilityLabel, accessibilityRole = "button", accessibilityHint, icon, iconOnly = /^refresh(?:ing)?\b/i.test(label) }: {
  label: string; onPress: () => void; colors: Colors; disabled?: boolean; tone?: string;
  expanded?: boolean; selected?: boolean; accessibilityLabel?: string; accessibilityRole?: "button" | "link"; accessibilityHint?: string; icon?: IconName; iconOnly?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const color = disabled ? colors.foregroundMuted : tone ?? colors.foreground;
  return <Pressable accessibilityRole={accessibilityRole} accessibilityHint={accessibilityHint} accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ disabled, expanded, selected }}
    {...(Platform.OS === "web" && iconOnly ? { title: accessibilityLabel ?? label } : {})}
    disabled={disabled} onPress={onPress} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={({ pressed }) => ({
      minHeight: Platform.OS === "web" ? 32 : 44, minWidth: iconOnly ? (Platform.OS === "web" ? 32 : 44) : undefined, paddingHorizontal: 9, paddingVertical: 4,
      flexDirection: "row", alignItems: "center", justifyContent: "center", alignSelf: "flex-start", gap: 5,
      borderWidth: 1, borderRadius: 6, borderColor: focused && !disabled ? colors.accent : selected ? colors.accent : colors.border,
      backgroundColor: !disabled && (pressed || selected) ? colors.surface2 : !disabled && hovered ? colors.surface1 : "transparent",
      opacity: disabled ? 0.45 : 1, flexShrink: 1,
    })}>
    <Icon name={icon ?? actionIcon(label, expanded)} size={13} color={color} />
    {!iconOnly ? <Text style={{ color, fontSize: 12, fontWeight: "500", flexShrink: 1 }}>{label.replace(/^←\s*|\s*[→↗▸▾▴]$/g, "")}</Text> : null}
  </Pressable>;
}

export function CompactExternalLink({ href, label, colors, accessibilityLabel }: { href: string; label: string; colors: Colors; accessibilityLabel?: string }) {
  const [error, setError] = useState<string | null>(null);
  return <View style={{ gap: 4, flexShrink: 1 }}>
    <CompactLink label={label} colors={colors} icon="ArrowUpRight" accessibilityRole="link" accessibilityLabel={accessibilityLabel} onPress={() => { setError(null); void openExternalUrl(href).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }} />
    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
  </View>;
}
