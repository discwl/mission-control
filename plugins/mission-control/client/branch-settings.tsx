import { usePaseo, useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";
import { branchNameSettings, branchTemplateProblem, exampleBranchName as exampleName } from "../shared/branch-names";
import { listBranchGuidance } from "../shared/paseo-metadata";

/** Settings → Plugins → Mission Control → Branch names: the host's branch-name template and per-project overrides. */
export function BranchSettings({ host }: PluginSurfaceProps) {
  const settings = useSettings(branchNameSettings);
  const paseo = usePaseo();
  const projects = useQuery({
    queryKey: ["mission-control", "branch-name-projects", host.id],
    queryFn: async () => (await paseo.projects.list()).projects.filter(project => project.projectKind === "git")
      .map(project => ({ id: project.projectId, name: project.projectCustomName || project.projectDisplayName })),
    retry: false,
  });
  // Each project's paseo.json branch name guidance, shown read only beside its template.
  const readGuidance = useRpc(listBranchGuidance);
  const guidance = useQuery({ queryKey: ["mission-control", "branch-guidance", host.id], queryFn: async () => (await readGuidance({})).projects, retry: false });
  // Drafts hold edits since the last load; a key missing from them shows the saved value.
  const [hostDraft, setHostDraft] = useState<string | null>(null);
  const [projectDrafts, setProjectDrafts] = useState<Record<string, string>>({});
  // Inputs keep their own text, so they remount with the saved values after a save or a discard.
  const [generation, setGeneration] = useState(0);
  // The saved revision the inputs show. It follows new saves only while nothing is being edited, so a
  // save from another client never replaces text the user is typing, and Save can't overwrite that save.
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const revision = settings.status === "ready" ? settings.revision : null;
  const editing = hostDraft !== null || Object.keys(projectDrafts).length > 0;
  useEffect(() => { if (revision !== null && !editing) setBaseRevision(revision); }, [revision, editing]);
  if (settings.status !== "ready") {
    return <SettingsSection title="Branch names">
      <SettingsRow label={settings.status === "loading" ? "Loading…" : "Branch name settings can't be read"} error={settings.status === "loading" ? null : settings.error} />
    </SettingsSection>;
  }
  const saved = settings.values;
  const hostTemplate = (hostDraft ?? saved.template).trim();
  const projectTemplate = (id: string) => (projectDrafts[id] ?? saved.projects[id] ?? "").trim();
  const hostProblem = branchTemplateProblem(hostTemplate);
  const problems = [hostProblem, ...Object.keys(projectDrafts).map(id => branchTemplateProblem(projectTemplate(id)))];
  const changed = hostTemplate !== saved.template.trim() || Object.keys(projectDrafts).some(id => projectTemplate(id) !== (saved.projects[id] ?? "").trim());
  const conflict = editing && baseRevision !== null && baseRevision !== settings.revision;

  async function save() {
    if (settings.status !== "ready" || conflict) return;
    const overrides = { ...settings.values.projects };
    for (const id of Object.keys(projectDrafts)) {
      const value = projectTemplate(id);
      if (value) overrides[id] = value; else delete overrides[id];
    }
    if (await settings.save({ ...settings.values, template: hostTemplate, projects: overrides }, settings.revision)) {
      setHostDraft(null); setProjectDrafts({}); setGeneration(value => value + 1);
    }
  }

  return <>
    <SettingsSection title="Branch names" info="Names for the branch a task gets when it starts in its own worktree. Git checks each name before the worktree is created, and a name another task already uses is refused. Existing task branches keep their names.">
      <SettingsInput key={`host-${baseRevision}-${generation}`} label="Template for this host"
        hint={`Tokens: {ticket} (the ticket key), {slug} (short description from the ticket's title), {type} (feature or bugfix), {id} (Mission Control's short task ID). Empty keeps task/{id}-{slug}. Tasks without a ticket always keep task/{id}-{slug}.${hostTemplate && !hostProblem ? ` Example: ${exampleName(hostTemplate)}` : ""}`}
        initialValue={saved.template} placeholder="task/{id}-{slug}" onChangeText={setHostDraft} error={hostProblem} />
    </SettingsSection>
    <SettingsSection title="Per project" info="An override replaces the host template for one project. Leave it empty to use the host template.">
      {projects.isPending ? <SettingsRow label="Loading projects…" /> : null}
      {projects.error ? <SettingsRow label="Projects can't be listed" error={projects.error instanceof Error ? projects.error.message : String(projects.error)} /> : null}
      {projects.data && !projects.data.length ? <SettingsRow label="No Git projects on this host" /> : null}
      {projects.data?.map(project => {
        const value = projectTemplate(project.id);
        const problem = branchTemplateProblem(value);
        const paseoJson = guidance.data?.find(entry => entry.projectId === project.id);
        return <Fragment key={`${project.id}-${baseRevision}-${generation}`}>
          <SettingsInput label={project.name}
            hint={value && !problem ? `Example: ${exampleName(value)}` : hostTemplate ? `Uses the host template: ${hostTemplate}` : "Uses task/{id}-{slug}."}
            initialValue={saved.projects[project.id] ?? ""} placeholder={hostTemplate || "task/{id}-{slug}"}
            onChangeText={text => setProjectDrafts(drafts => ({ ...drafts, [project.id]: text }))} error={problem} />
          {paseoJson?.guidance || paseoJson?.problem ? <SettingsRow label={`${project.name}: paseo.json branch guidance`}
            hint={paseoJson.guidance ? `${paseoJson.guidance}\n\nFrom ${paseoJson.path}. Read only: it guides Paseo's own branch names, while task branches use the template above.` : undefined}
            error={paseoJson.problem} /> : null}
        </Fragment>;
      })}
    </SettingsSection>
    <SettingsSection title="Save">
      <SettingsAction label={changed ? "Unsaved changes" : "Saved"}
        hint={settings.saving ? "Saving…" : "New task worktrees on this host use these names; Start task shows the name before it creates the branch."}
        error={conflict ? "Branch names were saved elsewhere while you were editing. Discard your changes to see the new values, then edit again." : settings.saveError}
        actionLabel={settings.saving ? "Saving…" : "Save branch names"} disabled={!changed || conflict || settings.saving || problems.some(Boolean)} onPress={() => void save()} />
      {changed || conflict ? <SettingsAction label="Discard changes" actionLabel="Discard" disabled={settings.saving}
        onPress={() => { setHostDraft(null); setProjectDrafts({}); setGeneration(value => value + 1); }} /> : null}
    </SettingsSection>
  </>;
}
