import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { readPipelineEvidence, type PipelineInspection } from "../shared/pipeline";
import { combineReviewFindings } from "../shared/stage-evidence.mjs";
import { CompactLink } from "./compact-link";
export function PipelineReviewEvidence({ serverId, workspaceId, taskId, pendingRequestId, colors, openAgent }: { serverId: string; workspaceId: string; taskId: string; pendingRequestId?: string; colors: PluginSurfaceProps["theme"]["colors"]; openAgent: (serverId: string, agentId: string) => void }) {
  const read = useRpc(readPipelineEvidence); const [expanded, setExpanded] = useState(false); const [data, setData] = useState<PipelineInspection | null>(null); const [error, setError] = useState(""); const [reload, setReload] = useState(0);
  useEffect(() => { if (pendingRequestId) setExpanded(true); }, [pendingRequestId]);
  useEffect(() => {
    if (!expanded) return; let active = true; setData(null); setError("");
    void read({ serverId, workspaceId, taskId }).then(value => { if (active) setData(value); }).catch(reason => { if (active) setError(String(reason.message ?? reason)); });
    return () => { active = false; };
  }, [expanded, serverId, workspaceId, taskId, pendingRequestId, reload, read]);
  const pendingWorker = data?.assignments?.find(item => item.requestId === pendingRequestId && pendingRequestId);
  const reviews = data?.checkpoints.filter(item => item.stage === "review" && item.planRevision === data.planRevision && item.candidate.head === data.candidate?.head && item.candidate.tree === data.candidate?.tree) ?? [];
  const findings = combineReviewFindings(reviews);
  return <View style={{ gap: 8 }}>
    <CompactLink label="Reviewers and evidence" colors={colors} expanded={expanded} onPress={() => setExpanded(value => !value)} />
    {expanded ? <>
      <CompactLink label="Refresh review evidence" colors={colors} onPress={() => setReload(value => value + 1)} />
      {error ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>{error}</Text> : !data ? <Text style={{ color: colors.foregroundMuted }}>Loading…</Text> : <>
        {pendingRequestId ? <View style={{ gap: 6 }}>
          <Text style={{ color: colors.statusWarning }}>{pendingWorker ? `Unconfirmed ${pendingWorker.stage} dispatch · ${pendingWorker.model}. Check this worker's conversation for the request before acknowledging delivery.` : "No matching worker receipt is available. Check the coordinator's native Subagents and the host workspace for a newly created worker before declaring this dispatch undelivered."}</Text>
          {pendingWorker ? <CompactLink label="Open worker for unconfirmed dispatch" colors={colors} onPress={() => openAgent(serverId, pendingWorker.agentId)} /> : null}
        </View> : null}
        <Text style={{ color: colors.foreground }}>{data.agentPolicy ? `${data.agentPolicy.reviewCount} independent review(s) required.` : "Legacy routing. Choose profiles to enable verified reviews."}</Text>
        {!reviews.length ? <Text style={{ color: colors.foregroundMuted }}>No review evidence for the current code and approved plan yet.</Text> : null}
        {reviews.map(item => <View key={item.id} style={{ gap: 4, padding: 10, backgroundColor: colors.surface2, borderRadius: 6 }}>
          <Text style={{ color: colors.foreground, fontWeight: "600" }}>{item.execution ? `${item.execution.profileName} · ${item.execution.provider}/${item.execution.model}` : "Legacy reviewer · model unverified"}</Text>
          <Text style={{ color: item.verdict === "pass" ? colors.accent : colors.statusWarning }}>{item.verdict} · {item.summary}</Text>
          <Text style={{ color: colors.foregroundMuted }}>{item.ocr ? `OCR executed · ${item.ocr.coverage.filter(file => file.outcome === "reviewed").length}/${item.ocr.coverage.length} selected files reviewed · ${item.ocr.excluded} excluded` : "No verified OCR execution record."}</Text>
          <CompactLink label="Open reviewer" colors={colors} onPress={() => openAgent(serverId, item.agentId)} />
        </View>)}
        {findings.map((item, index) => <View key={index} style={{ gap: 3 }}>
          <Text style={{ color: colors.foreground, fontWeight: "600" }}>{item.severity} · {item.title}</Text>
          <Text style={{ color: colors.foreground }}>{item.detail}</Text>
          <Text style={{ color: colors.foregroundMuted }}>Reported by {item.reviewers.map(author => author.model).join(", ")}</Text>
        </View>)}
        {reviews.some(item => item.verdict === "pass") && reviews.some(item => item.verdict !== "pass") ? <Text style={{ color: colors.statusWarning }}>Reviewers disagree. Both reports are retained; a passing review does not dismiss another reviewer's findings.</Text> : null}
      </>}
    </> : null}
  </View>;
}
