import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Fragment } from "react";
import { Text, View } from "react-native";

type Colors = PluginSurfaceProps["theme"]["colors"];
/** Static location context; segments never acquire navigation behavior. */
export function Breadcrumbs({ segments, colors, accessibilityLabel }: { segments: readonly string[]; colors: Colors; accessibilityLabel?: string }) {
  const labels = segments.filter(segment => segment.trim());
  return <View accessible accessibilityRole="text" accessibilityLabel={accessibilityLabel ?? labels.join(" / ")} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 5, minWidth: 0 }}>
    {labels.map((label, index) => <Fragment key={`${index}:${label}`}>
      {index ? <Text accessible={false} style={{ color: colors.foregroundMuted, fontSize: 12 }}>›</Text> : null}
      <Text accessible={false} selectable style={{ color: index === labels.length - 1 ? colors.foreground : colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontWeight: index === labels.length - 1 ? "600" : "400", flexShrink: 1, minWidth: 0, paddingHorizontal: index === labels.length - 1 ? 5 : 0, paddingVertical: 2, borderRadius: 4, backgroundColor: index === labels.length - 1 ? colors.surface2 : "transparent" }}>{label}</Text>
    </Fragment>)}
  </View>;
}
