import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import type { DecisionEntry } from "../shared/decisions";
import { readDecisionPlan, type PlanBrief } from "../shared/plan-approval";
import { planBriefFields } from "../shared/plan-brief.mjs";
import { useRpc } from "./host-rpc";
import { CompactLink } from "./compact-link";
import { MarkdownPreview } from "./markdown-preview";
import { formatDateTime } from "./date-time";

type Colors = PluginSurfaceProps["theme"]["colors"];
export const readablePlanRequest = "Please rewrite the plan for human approval: explain the goal, before/after behavior with an example, included and deferred scope, who is affected, proposed steps, success checks, risks, scope changes from the original request, and what approval allows next. Explain changes from the previous proposal. Save the full plan.md and request a fresh versioned plan decision with planBrief. Do not implement the revised scope before approval.";

export function usePlanApproval(entry: DecisionEntry, serverId: string) {
  const read = useRpc(readDecisionPlan);
  const d = entry.decision;
  return useQuery({
    queryKey: ["mission-control", "decision-plan", serverId, d.workspaceId, d.taskId, d.runId, d.decisionId, entry.revision],
    queryFn: () => read({ serverId, workspaceId: d.workspaceId, taskId: d.taskId, runId: d.runId, decisionId: d.decisionId, expectedRevision: entry.revision }),
    enabled: d.kind === "plan", retry: false, staleTime: 0,
    refetchInterval: d.kind === "plan" && d.status === "open" ? 20_000 : false,
  });
}
const display = (value: PlanBrief[keyof PlanBrief]) => Array.isArray(value) ? value.join("\n") : value;

export function PlanApprovalView({ entry, query, colors, fullDocument = false }: { entry: DecisionEntry; query: ReturnType<typeof usePlanApproval>; colors: Colors; fullDocument?: boolean }) {
  const [documentOpen, setDocumentOpen] = useState(fullDocument);
  const [compare, setCompare] = useState(false);
  const [raw, setRaw] = useState(false);
  const plan = query.data, brief = plan?.brief, previous = plan?.previous;
  const changed = brief && previous?.brief ? planBriefFields.filter(field => field.key !== "changesSincePrevious" && JSON.stringify(brief[field.key as keyof PlanBrief]) !== JSON.stringify(previous.brief![field.key as keyof PlanBrief])) : [];
  const body = { color: colors.foreground, fontSize: 14, lineHeight: 22 };
  const groups = [
    { title: "What will change", keys: ["goal", "before", "after"] },
    { title: "Scope and boundaries", keys: ["included", "deferred", "scopeChange", "affected"] },
    { title: "How it will be done", keys: ["approach"] },
    { title: "Checks and risks", keys: ["successChecks", "risks"] },
    { title: "What you are authorizing", keys: ["authorization"] },
  ];
  return <View style={{ gap: 12, paddingVertical: 8 }}>
    <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 16, fontWeight: "700" }}>{entry.decision.status === "open" ? "Plan for your approval" : "Saved plan"}</Text>
    {query.isPending ? <Text style={{ color: colors.foregroundMuted }}>Loading the saved proposal…</Text> : null}
    {query.isError ? <View style={{ gap: 6 }}><Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>The saved plan cannot be verified. Approval is unavailable; you can still request changes or stop.</Text><Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{/unknown.*(rpc|method)|not.*registered|no.*handler|handler_not_found|doesn.t offer decisions\.plan/i.test(String(query.error)) ? "This host needs the Mission Control plan approval update. Older requests also need a fresh versioned proposal." : String(query.error)}</Text></View> : null}
    {plan?.warning ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>{plan.warning}</Text> : null}
    {brief ? <View style={{ gap: 12 }}>
      {groups.map(group => <View key={group.title} style={{ gap: 14, paddingTop: 16, paddingBottom: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 16, fontWeight: "600" }}>{group.title}</Text>
        {group.keys.map(key => {
          const field = planBriefFields.find(field => field.key === key)!;
          const value = brief[field.key as keyof PlanBrief];
          return <View key={field.key} style={{ gap: 5 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 13, fontWeight: "600" }}>{field.label}</Text>
            {Array.isArray(value) ? value.length ? value.map((item, index) => <Text key={index} selectable style={body}>{field.key === "approach" ? `${index + 1}.` : "•"} {item}</Text>) : <Text style={{ ...body, color: colors.foregroundMuted }}>Not specified in this proposal.</Text> : <Text selectable style={body}>{value || "Not specified in this proposal."}</Text>}
          </View>;
        })}
      </View>)}
      <Text style={{ color: colors.foreground, fontWeight: "600" }}>What changed since the previous proposal</Text>
      {previous ? <>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Compared with the saved proposal from {formatDateTime(previous.requestedAt)}.</Text>
        <Text style={body}>{previous.brief ? changed.length ? `Changed sections: ${changed.map(field => field.label).join(", ")}.` : "The approval brief is unchanged." : "The earlier proposal has no readable brief to compare."}{previous.documentRevision !== plan.documentRevision ? " The full plan document also changed." : " The full plan document is unchanged."}</Text>
        {brief.changesSincePrevious.map((item, index) => <Text key={index} selectable style={body}>• Author's explanation: {item}</Text>)}
        {changed.length ? <CompactLink label={compare ? "Hide previous wording" : "Compare previous wording"} expanded={compare} colors={colors} onPress={() => setCompare(!compare)} /> : null}
        {compare ? changed.map(field => <View key={field.key} style={{ gap: 5, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border }}><Text style={{ ...body, fontWeight: "600" }}>{field.label}</Text><Text selectable style={{ ...body, color: colors.foregroundMuted }}>Previously: {display(previous.brief![field.key as keyof PlanBrief])}</Text><Text selectable style={body}>Proposed: {display(brief[field.key as keyof PlanBrief])}</Text></View>) : null}
      </> : <Text style={{ color: colors.foregroundMuted }}>No earlier saved plan version is available for comparison. This does not establish whether older proposals existed.</Text>}
    </View> : !query.isPending ? <View style={{ gap: 5 }}><Text style={{ color: colors.statusWarning }}>A structured approval brief was not provided. Missing scope, behavior, checks and risks are not inferred from technical notes.</Text>{entry.decision.plain?.built ? <Text selectable style={body}>Agent's existing summary: {entry.decision.plain.built}</Text> : null}</View> : null}
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Plan approval permits work within the described scope. Publishing, PRs, merges, deployments and Jira/ADO updates still need separate authorization.</Text>
    {plan?.markdown ? <>
      <CompactLink label={documentOpen ? "Hide full plan" : plan.source === "snapshot" ? "Read full saved plan" : "Read current plan (not a saved proposal)"} expanded={documentOpen} icon="FileText" colors={colors} onPress={() => setDocumentOpen(!documentOpen)} />
      {documentOpen ? <View style={{ gap: 10, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 7, backgroundColor: colors.surface0 }}><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{plan.source === "snapshot" ? `Saved proposal · ${formatDateTime(plan.requestedAt)} · version ${plan.revision!.slice(0, 10)}` : "Current working document · not captured when this request was made"}</Text><CompactLink label={raw ? "Formatted plan" : "Raw source"} colors={colors} onPress={() => setRaw(!raw)} />{raw ? <Text selectable style={body}>{plan.markdown}</Text> : <MarkdownPreview content={plan.markdown} colors={colors} documentPath={`Tasks/${entry.decision.taskId}/plan.md`} />}</View> : null}
    </> : null}
  </View>;
}

export function SavedPlanView({ entry, serverId, colors }: { entry: DecisionEntry; serverId: string; colors: Colors }) {
  const query = usePlanApproval(entry, serverId);
  return <View style={{ gap: 10 }}><Text style={{ color: colors.foregroundMuted }}>Decision recorded as {entry.decision.status.replaceAll("_", " ")}.</Text><PlanApprovalView entry={entry} query={query} colors={colors} fullDocument /></View>;
}
