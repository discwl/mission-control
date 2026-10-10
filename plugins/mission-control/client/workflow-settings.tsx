import { usePaseo, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { CompactLink } from "./compact-link";
import { getWorkflowInstructions, saveWorkflowInstructions } from "../shared/workflow-settings";
import { effectiveWorkflowInstructions, instructionLimit, workflowInstructionProblem, type InstructionMode, type WorkflowInstructions, type WorkflowStage } from "../shared/workflow-instructions.mjs";

type Props = PluginSurfaceProps & { projectId: string | null; onEditingChange: (editing: boolean) => void };
const labels: Record<InstructionMode, string> = { inherit: "Inherit host", append: "Add to host", replace: "Replace host" };
const examples = {
  intake: "If a ticket lacks acceptance criteria or business context, ask me focused questions before planning. Check the linked Confluence page and the reporting database using read-only queries. Reuse context I have already supplied.",
  planning: "Confirm unresolved business rules with me before implementation. Check the project's existing patterns and data model. Include tests for the agreed acceptance criteria.",
};

export function WorkflowInstructionsSettings(props: PluginSurfaceProps) {
  // A host change resets the selected scope; never query a previous host's project on another host.
  return <WorkflowSettingsBody key={props.host.id} {...props} />;
}

function WorkflowSettingsBody(props: PluginSurfaceProps) {
  const paseo = usePaseo();
  const colors = props.theme.colors;
  const [projectId, setProjectId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const projects = useQuery({ queryKey: ["mission-control", "workflow-projects", props.host.id],
    queryFn: async () => (await paseo.projects.list()).projects.map(project => ({ id: project.projectId, name: project.projectCustomName || project.projectDisplayName })), retry: false });
  return <>
    <SettingsSection title="Workflow instructions" info="Host defaults and project overrides for Intake and Planning. Guidance lives in this host's vault and is loaded by Morning check, task Start / Resume, /mission-task and dev-flow context.">
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Save or discard edits before switching scope. Tool connections and credentials are configured separately.</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <CompactLink label="Host defaults" colors={colors} selected={projectId === null} disabled={editing} onPress={() => setProjectId(null)} />
        {projects.data?.map(project => <CompactLink key={project.id} label={project.name} colors={colors} selected={projectId === project.id} disabled={editing} onPress={() => setProjectId(project.id)} />)}
      </View>
      {projects.isPending ? <SettingsRow label="Loading projects…" /> : null}
      {projects.error ? <SettingsRow label="Projects can't be listed" error={String(projects.error)} /> : null}
    </SettingsSection>
    <WorkflowEditor key={`${props.host.id}:${projectId ?? "host"}`} {...props} projectId={projectId} onEditingChange={setEditing} />
  </>;
}

export function WorkflowEditor({ host, theme, projectId, onEditingChange }: Props) {
  const colors = theme.colors;
  const read = useRpc(getWorkflowInstructions);
  const write = useRpc(saveWorkflowInstructions);
  const queryClient = useQueryClient();
  const queryKey = ["mission-control", "workflow-instructions", host.id, projectId];
  const query = useQuery({ queryKey, queryFn: () => read({ serverId: host.id, projectId }), retry: false, refetchInterval: 10_000 });
  // Keep the whole base snapshot while editing; background refreshes cannot replace the user's text.
  const [draft, setDraft] = useState<WorkflowInstructions | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation({ mutationFn: async () => {
    if (!draft) throw new Error("No edits to save.");
    return write({ serverId: host.id, projectId, expectedRevision: draft.revision, values: projectId === null ? draft.host : draft.project });
  }, onSuccess: snapshot => { queryClient.setQueryData(queryKey, snapshot); setDraft(null); setNotice("Workflow instructions saved."); } });
  useEffect(() => { onEditingChange(draft !== null || mutation.isPending); }, [draft, mutation.isPending, onEditingChange]);
  const snapshot = draft ?? query.data;
  if (!snapshot) return <SettingsSection title="Guidance"><SettingsRow label={query.isPending ? "Loading instructions…" : "Instructions can't be read"} error={query.error ? String(query.error) : null} /></SettingsSection>;
  const loaded: WorkflowInstructions = snapshot;
  const values = projectId === null ? snapshot.host : snapshot.project;
  const effective = effectiveWorkflowInstructions(snapshot.host, projectId === null ? undefined : snapshot.project);
  const conflict = draft !== null && query.data !== undefined && draft.revision !== query.data.revision;
  const problem = workflowInstructionProblem(values, projectId !== null);
  function update(stage: WorkflowStage, text: string) {
    mutation.reset(); setNotice(null);
    setDraft(current => { const base = current ?? loaded; const key = projectId === null ? "host" : "project"; return { ...base, [key]: { ...base[key], [stage]: text } }; });
  }
  function mode(stage: WorkflowStage, value: InstructionMode) {
    mutation.reset(); setNotice(null);
    setDraft(current => { const base = current ?? loaded; return { ...base, project: { ...base.project, [`${stage}Mode`]: value } }; });
  }
  return <>
    <SettingsSection title={projectId === null ? "Host defaults" : "Project guidance"} info={projectId === null ? "These instructions apply to every project unless it overrides them." : "Choose how each stage uses the host defaults. Replace can intentionally remove the host guidance by leaving the project text empty."}>
      {(["intake", "planning"] as const).map(stage => {
        const selectedMode = snapshot.project[`${stage}Mode`];
        return <View key={stage} style={{ gap: 8, paddingVertical: 8 }}>
          <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>{stage === "intake" ? "Intake" : "Planning"}</Text>
          {projectId !== null ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {(["inherit", "append", "replace"] as const).map(value => <CompactLink key={value} label={labels[value]} colors={colors} selected={selectedMode === value} disabled={mutation.isPending} accessibilityLabel={`${stage}: ${labels[value]}`} onPress={() => mode(stage, value)} />)}
          </View> : null}
          <TextInput accessibilityLabel={`${stage === "intake" ? "Intake" : "Planning"} instructions`} multiline value={values[stage]} onChangeText={text => update(stage, text)}
            editable={!mutation.isPending && (projectId === null || selectedMode !== "inherit")} maxLength={instructionLimit} placeholder={examples[stage]} placeholderTextColor={colors.foregroundMuted}
            style={{ minHeight: 130, padding: 10, borderRadius: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, color: colors.foreground, fontSize: 13, textAlignVertical: "top", opacity: projectId !== null && selectedMode === "inherit" ? 0.6 : 1 }} />
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{values[stage].length} / {instructionLimit} characters{projectId !== null && selectedMode === "inherit" ? " · Project text is retained but does not apply while inheriting." : ""}</Text>
        </View>;
      })}
    </SettingsSection>
    <SettingsSection title="Effective guidance" info="Preview updates as you edit. Saved guidance reaches agents on their next launch, resume or workflow context read; saving does not interrupt a running agent.">
      {(["intake", "planning"] as const).map(stage => <View key={stage} style={{ gap: 4, paddingVertical: 6 }}>
        <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 13 }}>{stage === "intake" ? "Intake" : "Planning"} · {projectId === null ? "Host defaults" : labels[snapshot.project[`${stage}Mode`]]}</Text>
        <Text selectable style={{ color: colors.foregroundMuted, fontSize: 13 }}>{effective[stage] || "No custom guidance. The normal workflow skills still apply."}</Text>
      </View>)}
      <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>Host note: {snapshot.paths.host}{snapshot.paths.project ? `\nProject note: ${snapshot.paths.project}` : ""}</Text>
    </SettingsSection>
    <SettingsSection title="Save">
      {conflict || problem || mutation.error || query.error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{conflict ? "Instructions changed elsewhere. Discard edits to load the latest values, then edit again." : problem ?? String(mutation.error ?? query.error)}</Text> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={{ color: colors.statusSuccess, fontSize: 12 }}>{notice}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <CompactLink label={mutation.isPending ? "Saving…" : "Save instructions"} colors={colors} disabled={draft === null || conflict || !!problem || !!query.error || mutation.isPending} onPress={() => mutation.mutate()} />
        <CompactLink label={draft ? "Discard changes" : "Reload"} colors={colors} disabled={mutation.isPending} onPress={() => { setDraft(null); setNotice(null); mutation.reset(); void query.refetch(); }} />
      </View>
    </SettingsSection>
  </>;
}
