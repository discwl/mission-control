import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import type { FleetTask } from "../shared/fleet";
import type { ReviewSnapshot } from "../shared/review";
import { listTaskDocuments } from "../shared/tasks";
import { useRpc } from "./host-rpc";
import { CompactLink } from "./compact-link";
import { DecisionCard } from "./decision-card";
import { MarkdownPreview } from "./markdown-preview";
import { ArtifactCard } from "./task-flow-content";
import { recentActivity } from "./task-flow-model";
import { resolveEvidence } from "./task-flow-presentation";
import { findingDiffPath, reviewReportModel } from "./review-report-model";
import { formatDateTime } from "./date-time";

type Colors = PluginSurfaceProps["theme"]["colors"];
export function ReviewReport({ entry, serverId, workspace, snapshot, stale, colors, selectFile, openAgent, onEvidence }: {
  entry: FleetTask; serverId: string; workspace: { id: string; name: string; projectName: string; hostLabel: string };
  snapshot: ReviewSnapshot | null; stale: boolean; colors: Colors;
  selectFile(path: string): void; openAgent(id: string): void; onEvidence(): void;
}) {
  const read = useRpc(listTaskDocuments);
  const documents = useQuery({ queryKey: ["mission-control", "flow-documents", serverId, workspace.id, entry.task.taskId], queryFn: () => read({ serverId, workspaceId: workspace.id, taskId: entry.task.taskId }), staleTime: 10_000, refetchInterval: 15_000, retry: false });
  const docs = documents.data?.documents ?? [];
  const activity = recentActivity(docs, entry.task.taskId);
  const model = reviewReportModel(entry, serverId, workspace.id, snapshot, stale, activity.events);
  const review = model.review;
  const [selectedDocument, setSelectedDocument] = useState<string | null>(null);
  const references = [...new Set([...(review?.decision.evidence ?? []), ...(model.validation ? [model.validation.source, ...model.validation.evidence] : [])])];
  const resolved = references.map(value => resolveEvidence(value, docs, entry.task.taskId));
  const referencedDocuments = [...new Map(resolved.flatMap(item => item.kind === "document" ? [[item.document.name, item.document] as const] : [])).values()];
  const selected = selectedDocument ?? referencedDocuments[0]?.name;
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 22 } as const;
  const muted = { ...text, color: colors.foregroundMuted };
  const heading = { ...text, fontSize: 17, fontWeight: "600" } as const;
  return <View style={{ gap: 20, paddingVertical: 16 }}>
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={heading}>Review result</Text>
      <Text style={model.canDecide ? muted : { ...muted, color: colors.statusWarning }}>{model.warning}</Text>
      {review ? <>
        <Text selectable style={muted}>Requested {formatDateTime(review.decision.requestedAt)} · {review.decision.status.replaceAll("_", " ")} · reviewed commit {review.decision.gitHead?.slice(0, 12) ?? "not recorded"}{review.decision.gitDirty ? " with uncommitted changes" : ""}</Text>
        {review.decision.candidate ? <Text selectable style={muted}>Candidate tree {review.decision.candidate.tree.slice(0, 12)}</Text> : <Text style={muted}>Exact candidate was not recorded in this older request.</Text>}
        {review.decision.reviewVerification?.reviewers.length ? review.decision.reviewVerification.reviewers.map(reviewer => <View key={reviewer.checkpointId} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <Text style={text}>{reviewer.profile} · {reviewer.model} · {reviewer.reviewed}/{reviewer.selected} selected files reviewed · {reviewer.excluded} excluded</Text>
          <CompactLink label="Open reviewer conversation" colors={colors} icon="MessageSquare" onPress={() => openAgent(reviewer.agentId)} />
        </View>) : <Text style={muted}>Reviewer identity and model verification were not recorded for this request.</Text>}
        {review.decision.agentId ? <CompactLink label="Open requesting worker conversation" icon="MessageSquare" colors={colors} onPress={() => openAgent(review.decision.agentId!)} /> : null}
      </> : null}
    </View>
    {review ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 28 }}>
      <View style={{ flexBasis: 720, flexGrow: 2, flexShrink: 1, minWidth: 0, maxWidth: "100%", gap: 24 }}>
        <View style={{ gap: 8 }}>
          <Text accessibilityRole="header" style={heading}>Saved review report</Text>
          {review.decision.plain?.found ? <Text selectable style={text}>{review.decision.plain.found}</Text> : null}
          {review.summary.trim() ? <MarkdownPreview content={review.summary} colors={colors} /> : <Text style={muted}>No detailed report was saved with this request. Read the referenced documents below.</Text>}
        </View>
        <View style={{ gap: 12 }}>
          <Text accessibilityRole="header" style={heading}>Findings</Text>
          <Text style={muted}>{review.unverifiedFindings} findings from earlier rounds still await verification. No listed findings does not prove the work is complete.</Text>
          {!model.findings.length ? <Text style={muted}>No findings are attached to this request.</Text> : model.findings.map(finding => {
            const path = findingDiffPath(finding.file, snapshot);
            return <View key={finding.findingId} style={{ gap: 6, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
              <Text style={{ ...text, fontWeight: "600" }}>{finding.severity.toUpperCase()} · {finding.status.replaceAll("_", " ")} · {finding.title}</Text>
              {finding.plain?.description ? <Text selectable style={text}>{finding.plain.description}</Text> : null}
              {finding.detail ? <Text selectable style={text}>{finding.detail}</Text> : null}
              {finding.plain?.impact ? <Text style={muted}>If left unresolved: {finding.plain.impact}</Text> : null}
              {path ? <CompactLink label={`View ${finding.file} in code changes`} colors={colors} onPress={() => selectFile(path)} /> : finding.file ? <Text selectable style={muted}>{finding.file} · not present in the displayed diff</Text> : null}
            </View>;
          })}
        </View>
        <View style={{ gap: 8 }}>
          <Text accessibilityRole="header" style={heading}>Validation</Text>
          <Text style={muted}>Reported checks are evidence supplied by the worker, not checks rerun by this screen.</Text>
          {review.decision.plain?.checks?.length ? review.decision.plain.checks.map((check, index) => <Text key={index} selectable style={text}>• {check}</Text>) : <Text style={muted}>No check results were included in the review summary.</Text>}
          {review.decision.plain?.limitations?.map((limitation, index) => <Text key={index} style={{ ...text, color: colors.statusWarning }}>Limitation: {limitation}</Text>)}
          {model.validation ? <>
            <Text style={model.validationStale ? { ...muted, color: colors.statusWarning } : muted}>Recorded {model.validation.outcome.replaceAll("_", " ")} · {formatDateTime(model.validation.at)} · {model.validationStale ? "out of date or revision unverified" : "read the results; matching commits alone do not verify working changes"}</Text>
            <MarkdownPreview content={model.validation.body} colors={colors} />
          </> : <Text style={muted}>{documents.isPending ? "Loading saved validation…" : "No validation record matched this task's current run."}</Text>}
        </View>
        <View style={{ gap: 8 }}>
          <Text accessibilityRole="header" style={heading}>Referenced reports and evidence</Text>
          <Text style={muted}>These documents are read from the owning host now and may have changed since the review request.</Text>
          {documents.isPending ? <Text style={muted}>Loading referenced documents…</Text> : null}
          {documents.isError ? <Text accessibilityRole="alert" style={{ ...text, color: colors.statusWarning }}>Saved documents could not be refreshed. Cached content may be outdated. {String(documents.error)}</Text> : null}
          {referencedDocuments.map(document => <ArtifactCard key={`${review.decision.decisionId}:${document.name}`} document={document} events={activity.events} selected={selected === document.name} colors={colors} onSelect={() => setSelectedDocument(selected === document.name ? "" : document.name)} documentPath={`Tasks/${entry.task.taskId}/${document.name}`} />)}
          {resolved.flatMap((item, index) => item.kind === "document" ? [] : [<Text key={index} selectable style={muted}>{item.text}{item.kind === "unavailable" ? " · document unavailable in the returned task evidence" : ""}</Text>])}
          {!references.length ? <Text style={muted}>No report documents were referenced by this request or its validation record.</Text> : null}
          <CompactLink label="All task evidence" colors={colors} onPress={onEvidence} />
        </View>
      </View>
      <View style={{ flexBasis: 360, flexGrow: 1, flexShrink: 1, minWidth: 0, maxWidth: "100%", gap: 12 }}>
        <Text accessibilityRole="header" style={heading}>Your decision</Text>
        <Text style={text}>Read the report and inspect the code changes below. Accept reviewed code or describe the fixes you need. Acceptance does not authorize publishing or merging.</Text>
        {model.canDecide ? <DecisionCard key={review.decision.decisionId} entry={review} serverId={serverId} hostLabel={workspace.hostLabel} colors={colors} actions={{ describe: () => ({ hostLabel: workspace.hostLabel, projectName: workspace.projectName, workspaceName: workspace.name }), openAgent, openDocs: onEvidence, agentOf: () => null }} />
          : <Text style={muted}>{review.decision.status === "open" ? "Decision controls are unavailable until the displayed revision and review are current." : `This request is already ${review.decision.status.replaceAll("_", " ")}. Use Receipt to inspect its saved outcome and worker delivery.`}</Text>}
        <Text style={muted}>After saving, check Receipt. Decision saved, delivered to the worker, and work resumed are separate states.</Text>
      </View>
    </View> : null}
    <Text accessibilityRole="header" style={heading}>Code changes</Text>
  </View>;
}
