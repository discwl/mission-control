import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { readDecisionReview, type DecisionEntry } from "../shared/decisions";
import { useRpc } from "./host-rpc";
import { CompactLink } from "./compact-link";

type Colors = PluginSurfaceProps["theme"]["colors"];
export function FrozenReview({ entry, colors }: { entry: DecisionEntry; colors: Colors }) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const read = useRpc(readDecisionReview);
  const { decision } = entry;
  const context = decision.reviewContext;
  const query = useQuery({ queryKey: ["mission-control", "frozen-review", decision.serverId, decision.workspaceId, decision.taskId, decision.runId, decision.decisionId, entry.revision],
    queryFn: () => read({ serverId: decision.serverId, workspaceId: decision.workspaceId, taskId: decision.taskId, runId: decision.runId, decisionId: decision.decisionId, expectedRevision: entry.revision }),
    enabled: expanded && !!context, retry: false, staleTime: Infinity });
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 };
  if (!context) return <Text style={muted}>The comparison base was not recorded for this older review. The live workspace diff below may include upstream changes; read the saved review report for its scope.</Text>;
  const files = query.data?.files ?? [];
  const file = files.find(file => file.path === selected) ?? files[0];
  return <View style={{ gap: 10 }}>
    <Text selectable style={muted}>Reported review base {context.baseCommit.slice(0, 12)} → frozen tree {context.candidate.tree.slice(0, 12)}. This preserves the reported scope; it does not verify who performed the review.</Text>
    <CompactLink label={expanded ? "Hide saved candidate diff" : "Read saved candidate diff"} expanded={expanded} colors={colors} onPress={() => setExpanded(!expanded)} />
    {expanded ? <>
      {query.isPending ? <Text style={muted}>Loading saved Git objects…</Text> : null}
      {query.isError ? <Text accessibilityRole="alert" style={{ ...muted, color: colors.statusWarning }}>Saved diff unavailable. No live diff has been substituted. {String(query.error)}</Text> : null}
      {query.data ? <Text style={muted}>{files.length} changed files in the saved comparison. Current workspace edits are excluded.</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{files.map(file => <CompactLink key={file.path} label={file.path} selected={file.path === (selected ?? files[0]?.path)} colors={colors} onPress={() => setSelected(file.path)} />)}</View>
      {file ? <View style={{ gap: 8, minWidth: 0 }}>
        <Text selectable style={{ color: colors.foreground, fontWeight: "600" }}>{file.path} · +{file.additions} −{file.deletions}</Text>
        {file.truncated ? <Text style={{ ...muted, color: colors.statusWarning }}>This file exceeds the preview limit. The displayed lines are incomplete.</Text> : null}
        {!file.hunks.length ? <Text style={muted}>No text hunks are available ({file.change}). Inspect the original artifact.</Text> : file.hunks.map(hunk => <View key={hunk.contentId} style={{ gap: 4 }}>
          <Text selectable style={muted}>{hunk.header}</Text>
          {hunk.lines.map((line, index) => <Text key={index} selectable style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 18, flexShrink: 1, color: line.kind === "add" ? colors.statusSuccess : line.kind === "del" ? colors.statusDanger : colors.foreground }}>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}{line.text}</Text>)}
        </View>)}
      </View> : null}
    </> : null}
  </View>;
}
