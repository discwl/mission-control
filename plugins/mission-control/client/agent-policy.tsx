import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { readAgentPolicy, saveAgentPolicy, roleMappingSchema, resolveRolePolicy, workflowRoles, type RoleMapping } from "../shared/agent-policy";
import { CompactLink } from "./compact-link";
import type { z } from "zod";
type Colors = PluginSurfaceProps["theme"]["colors"];
const names = { planner: "Planning", builder: "Implementation and fixes", validator: "Validation", reviewer: "Independent review", reviewer2: "Second independent review" };
export function TaskAgentPolicyEditor(props: { serverId: string; projectId: string; taskId: string; colors: Colors }) {
  const [scope, setScope] = useState<"task" | "project">("task");
  return <View style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", gap: 8 }}>
      <CompactLink label="This task's agents" colors={props.colors} selected={scope === "task"} onPress={() => setScope("task")} />
      <CompactLink label="Project defaults" colors={props.colors} selected={scope === "project"} onPress={() => setScope("project")} />
    </View>
    <AgentPolicyEditor key={`${props.serverId}:${props.projectId}:${scope === "task" ? props.taskId : "project"}`} {...props} taskId={scope === "task" ? props.taskId : null} label={scope === "task" ? "This task" : "This project"} />
  </View>;
}

export function AgentPolicyEditor({ serverId, projectId = null, taskId = null, label, colors }: { serverId: string; projectId?: string | null; taskId?: string | null; label: string; colors: Colors }) {
  const read = useRpc(readAgentPolicy); const save = useRpc(saveAgentPolicy);
  const [data, setData] = useState<z.infer<typeof readAgentPolicy.output> | null>(null);
  const [draft, setDraft] = useState<RoleMapping>({ planner: "", builder: "", validator: null, reviewer: "", reviewer2: null, reviewCount: 1 });
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    let active = true; setData(null); setError("");
    void read({ serverId, projectId, taskId }).then(value => {
      if (!active) return;
      setData(value);
      const selected = value.policies.find(item => item.projectId === projectId && item.taskId === taskId)
        ?? value.policies.find(item => item.projectId === projectId && !item.taskId)
        ?? value.policies.find(item => !item.projectId && !item.taskId);
      setDraft(selected?.mapping ?? { planner: "", builder: "", validator: null, reviewer: "", reviewer2: null, reviewCount: 1 });
    }).catch(reason => { if (active) setError(String(reason.message ?? reason)); });
    return () => { active = false; };
  }, [expanded, serverId, projectId, taskId, reload, read]);
  let problem = "";
  if (data) try { resolveRolePolicy([{ projectId, taskId, updatedAt: "preview", mapping: roleMappingSchema.parse(draft) }], data.profiles, projectId, taskId); }
  catch (reason) { problem = reason instanceof Error ? reason.message : String(reason); }
  async function persist(mapping: RoleMapping | null) {
    if (!data) return; setBusy(true); setError("");
    try { await save({ serverId, projectId, taskId, mapping, expectedRevision: data.revision }); setReload(value => value + 1); setEditing(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <View style={{ gap: 10, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
    <CompactLink label={`Agent profiles · ${label}`} colors={colors} expanded={expanded} onPress={() => setExpanded(value => !value)} />
    {expanded ? <>
      <Text style={{ color: colors.foregroundMuted }}>Choose native Paseo profiles from this host. Configure their model, reasoning and permissions in Paseo Settings → Agent profiles. Saved choices apply to future stage launches; running agents keep their configuration.</Text>
      <Text style={{ color: colors.foregroundMuted }}>Scope: {taskId ? "This task" : projectId ? "This project" : "Host default"}. Task settings override project settings, which override the host default.</Text>
      {!data && !error ? <Text style={{ color: colors.foregroundMuted }}>Loading profiles…</Text> : null}
      {data ? <>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{([1, 2] as const).map(count => <CompactLink key={count} label={count === 1 ? "One reviewer" : "Two different models"} colors={colors} selected={draft.reviewCount === count} disabled={busy} onPress={() => setDraft(value => ({ ...value, reviewCount: count }))} />)}</View>
        {workflowRoles.filter(role => role !== "reviewer2" || draft.reviewCount === 2).map(role => {
          const profile = data.profiles.find(item => item.id === draft[role]);
          return <View key={role} style={{ gap: 6 }}>
            <Text style={{ color: colors.foreground, fontWeight: "600" }}>{names[role]}</Text>
            <CompactLink label={profile ? `${profile.name} · ${profile.provider}/${profile.model ?? "Choose model"}` : role === "validator" && !draft.validator ? "Use implementation profile" : "Choose a native profile"} colors={colors} disabled={busy} expanded={editing === role} onPress={() => setEditing(editing === role ? null : role)} />
            {editing === role ? <View style={{ gap: 6, paddingLeft: 12 }}>
              {role === "validator" ? <CompactLink label="Use implementation profile" colors={colors} onPress={() => { setDraft(value => ({ ...value, validator: null })); setEditing(null); }} /> : null}
              {data.profiles.map(item => <CompactLink key={item.id} label={`${item.name} · ${item.provider}/${item.model ?? "No explicit model"}`} colors={colors} selected={draft[role] === item.id} onPress={() => { setDraft(value => ({ ...value, [role]: item.id })); setEditing(null); }} />)}
              {!data.profiles.length ? <Text style={{ color: colors.statusWarning }}>Create a native profile on this host, then refresh.</Text> : null}
            </View> : null}
          </View>;
        })}
        {problem ? <Text style={{ color: colors.statusWarning }}>Choose explicit models for the required roles. Two reviewers must use different models.</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <CompactLink label={busy ? "Saving…" : "Save agent choices"} colors={colors} disabled={busy || Boolean(problem)} onPress={() => void persist(draft)} />
          {projectId ? <CompactLink label="Use inherited choices" colors={colors} disabled={busy} onPress={() => void persist(null)} /> : null}
          <CompactLink label="Refresh profiles" colors={colors} disabled={busy} onPress={() => setReload(value => value + 1)} />
        </View>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{data.effective ? `Saved: ${data.effective.reviewCount} reviewer(s), from ${data.effective.source} settings.` : "No saved mapping. Existing coordinator routing continues until you save choices."} OCR selection and rules are executed before managed reviews; coverage and both reviewers' findings are retained.</Text>
      </> : null}
      {error || data?.problem ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>{error || data?.problem}</Text> : null}
    </> : null}
  </View>;
}
