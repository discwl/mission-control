import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { ReviewSnapshot } from "../shared/review";
import { CompactLink } from "./compact-link";
import { usePageState } from "./page-state";
import { formatDateTime } from "./date-time";
import { compareReviewBaseline, makeReviewBaseline, restoreReviewBaseline, type ReviewBaseline } from "./review-changes-model";
import { readClientStorage, writeClientStorage } from "./web";

const storageKey = "mission-control:review-comparisons:v1";
function readBaseline(identity: string): ReviewBaseline | null {
  try {
    const values: unknown = JSON.parse(readClientStorage(storageKey) ?? "[]");
    return Array.isArray(values) ? values.map(value => restoreReviewBaseline(value, identity)).find(Boolean) ?? null : null;
  } catch { return null; }
}
function saveBaseline(baseline: ReviewBaseline) {
  try {
    const values: unknown = JSON.parse(readClientStorage(storageKey) ?? "[]");
    const others = Array.isArray(values) ? values.filter(value => value && value.identity !== baseline.identity).slice(-19) : [];
    writeClientStorage(storageKey, JSON.stringify([...others, baseline]));
  } catch { /* Comparison is still available until this view closes. */ }
}
export function ReviewChanges({ identity, snapshot, stale, colors, onSelect, onFilter }: {
  identity: string; snapshot: ReviewSnapshot | null; stale: boolean; colors: PluginSurfaceProps["theme"]["colors"];
  onSelect(path: string): void; onFilter(paths: readonly string[] | null): void;
}) {
  const [initial] = useState(() => readBaseline(identity));
  const [baseline, setBaseline] = useState(initial);
  const [expanded, setExpanded] = usePageState(`review-comparison:${identity}:expanded`, false);
  const [filtered, setFiltered] = usePageState(`review-comparison:${identity}:filtered`, false);
  const comparison = snapshot ? compareReviewBaseline(baseline, identity, snapshot) : null;
  const changed = comparison?.state === "comparable" ? [...comparison.added, ...comparison.changed] : [];
  useEffect(() => {
    if (!snapshot || stale || baseline) return;
    const next = makeReviewBaseline(identity, snapshot);
    setBaseline(next);
    // Layout changes can remount a panel. Advance only through an explicit checkpoint,
    // so opening, refreshing or resizing cannot acknowledge changes the user has not reviewed.
    saveBaseline(next);
  }, [identity, snapshot?.fingerprint, stale, baseline]);
  useEffect(() => { onFilter(filtered && comparison?.state === "comparable" ? changed : null); }, [filtered, comparison?.state, JSON.stringify(changed)]);
  if (!snapshot) return null;
  const warning = stale || comparison?.state === "scope-changed" || comparison?.partial;
  const text = (value: string) => <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{value}</Text>;
  return <View style={{ gap: 7, borderColor: warning ? colors.statusWarning : colors.border, borderWidth: 1, borderRadius: 7, padding: 10 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <CompactLink label={initial ? "Changes since review checkpoint" : "Since opening this review"} expanded={expanded} colors={colors} onPress={() => setExpanded(!expanded)} />
      {comparison?.state === "comparable" ? text(`${comparison.added.length} new · ${comparison.changed.length} changed · ${comparison.removed.length} no longer listed · ${comparison.unchanged} same shown changes`) : null}
      {comparison?.state === "comparable" && changed.length ? <CompactLink label={filtered ? "Show all files" : "Show changed files"} selected={filtered} colors={colors} onPress={() => setFiltered(!filtered)} /> : null}
    </View>
    {stale ? text("The displayed snapshot is out of date or cannot be checked. Refresh before relying on this comparison.") : null}
    {comparison?.state === "scope-changed" ? text("The branch, repository, or comparison base changed. File differences cannot be compared reliably with your previous visit. Review the full scope or choose a new comparison point.") : null}
    {comparison?.partial ? text("One comparison contains omitted or truncated content. Counts cover the shown changes only; inspect the full files for a complete review.") : null}
    {expanded ? <View style={{ gap: 7 }}>
      {text(baseline ? `Compared with snapshot ${formatDateTime(baseline.at)}. Only comparison metadata is saved on this device. Save a checkpoint when you want future comparisons to start here; this does not mark files reviewed or approve work.` : "Your first current snapshot will establish a comparison point on this device.")}
      {comparison?.state === "comparable" ? <>
        {text(`${comparison.newParts} new or changed review parts. Unchanged parts keep their existing review marks. This does not verify that feedback was addressed.`)}
        {comparison.added.map(path => <CompactLink key={`new:${path}`} label={`New: ${path}`} colors={colors} onPress={() => onSelect(path)} />)}
        {comparison.changed.map(path => <CompactLink key={`changed:${path}`} label={`Changed: ${path}`} colors={colors} onPress={() => onSelect(path)} />)}
        {comparison.removed.map(path => <Text key={`removed:${path}`} selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>No longer in current review: {path}</Text>)}
        {comparison.removed.length ? text("A file leaving this diff is not proof that an issue was fixed. Its comments and decisions remain separate.") : null}
      </> : null}
      <CompactLink label="Save review checkpoint" colors={colors} disabled={stale} onPress={() => { const next = makeReviewBaseline(identity, snapshot); setBaseline(next); saveBaseline(next); setFiltered(false); }} />
    </View> : null}
  </View>;
}
