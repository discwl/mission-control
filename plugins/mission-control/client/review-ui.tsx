import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";
import type { Severity } from "../shared/review";
import { severityLabel } from "./review-rows";
import { CompactLink } from "./compact-link";

export type Colors = PluginSurfaceProps["theme"]["colors"];

export const mono = { fontFamily: "monospace", fontSize: 12, lineHeight: 18 } as const;
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function severityColor(severity: Severity, colors: Colors) {
  return severity === "high" ? colors.statusDanger : severity === "medium" ? colors.statusWarning : severity === "low" ? colors.accent : colors.foregroundMuted;
}

export function SeverityBadge({ severity, colors }: { severity: Severity; colors: Colors }) {
  const color = severityColor(severity, colors);
  return <View style={{ borderColor: color, borderWidth: 1, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
    <Text style={{ color, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 }}>{severityLabel[severity]}</Text>
  </View>;
}

export function Chip({ label, color, colors }: { label: string; color?: string; colors: Colors }) {
  const tone = color ?? colors.foregroundMuted;
  return <View style={{ borderColor: tone, borderWidth: 1, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 }}>
    <Text style={{ color: tone, fontSize: 10, fontWeight: "700" }}>{label}</Text>
  </View>;
}

export function Toggle<T extends string>({ options, value, onChange, colors, label }: { options: [T, string][]; value: T; onChange: (value: T) => void; colors: Colors; label: string }) {
  return <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: "row", borderColor: colors.border, borderWidth: 1, borderRadius: 7, overflow: "hidden" }}>
    {options.map(([key, text]) => <Pressable key={key} accessibilityRole="radio" accessibilityState={{ selected: value === key }} onPress={() => onChange(key)}
      style={{ minHeight: 36, paddingHorizontal: 11, justifyContent: "center", backgroundColor: value === key ? colors.accent : "transparent" }}>
      <Text style={{ color: value === key ? colors.accentForeground : colors.foregroundMuted, fontSize: 12, fontWeight: value === key ? "600" : "400" }}>{text}</Text>
    </Pressable>)}
  </View>;
}

export function LinkButton({ label, onPress, colors, disabled, tone }: { label: string; onPress: () => void; colors: Colors; disabled?: boolean; tone?: string }) {
  return <CompactLink label={label} onPress={onPress} colors={colors} disabled={disabled} tone={tone} />;
}

/** Tinted background that works with any theme colour format. */
export function Tint({ color }: { color: string | null }) {
  return color ? <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: color, opacity: 0.14 }} /> : null;
}
