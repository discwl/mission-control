import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { defaultPullRequestTitle, deliveryModeLabels, deliverySettings, examplePullRequestTitle, listProjectRemotes, pullRequestTitleProblem, type DeliveryMode } from "../shared/delivery";
import { detectForge, forgeHostPattern, forgeLabels, forges, forgeSourceLabels, forgeWebHostPattern, type Forge, type ForgeHostMapping } from "../shared/forges";

type ProjectMode = DeliveryMode | "host";
type ProjectForge = Forge | "detect";
type ProjectDraft = { mode?: ProjectMode; titleTemplate?: string; forge?: ProjectForge };
// A custom host being edited; key keeps its inputs stable while rows are added and removed.
type HostDraft = ForgeHostMapping & { key: string };

const hostModes = [{ label: deliveryModeLabels.merge, value: "merge" }, { label: deliveryModeLabels["pull-request"], value: "pull-request" }] as const;
const forgeOptions = forges.map(forge => ({ label: forgeLabels[forge], value: forge }));

/** Why a custom host can't be saved; null when it is usable. */
function hostProblem(entry: ForgeHostMapping, all: readonly ForgeHostMapping[]) {
  const match = entry.match.trim();
  if (!match) return "Enter the host or SSH alias as it appears in origin's URL.";
  if (!forgeHostPattern.test(match)) return "Use a host name or SSH alias, such as github.example.com or github-work.";
  if (all.filter(other => other.match.trim().toLowerCase() === match.toLowerCase()).length > 1) return `${match} is listed twice.`;
  if (entry.host.trim() && !forgeWebHostPattern.test(entry.host.trim())) return "For the web address, use a host name, host:port, or a base URL such as http://tfs.corp:8080.";
  return null;
}

/**
 * Settings → Plugins → Mission Control → Delivery: how Attention delivers an approved task, Merge (into the main
 * checkout) or a draft pull request, for the host and per project; the pull request's title template; and which
 * forge each project's origin is on: detected, mapped from a custom host or SSH alias, or set per project.
 */
export function DeliverySettings({ host }: PluginSurfaceProps) {
  const settings = useSettings(deliverySettings);
  const readRemotes = useRpc(listProjectRemotes);
  const projects = useQuery({ queryKey: ["mission-control", "delivery-remotes", host.id], queryFn: async () => (await readRemotes({})).projects, retry: false });
  // Drafts hold edits since the last load; a key missing from them shows the saved value.
  const [hostMode, setHostMode] = useState<DeliveryMode | null>(null);
  const [hostTemplate, setHostTemplate] = useState<string | null>(null);
  const [projectDrafts, setProjectDrafts] = useState<Record<string, ProjectDraft>>({});
  const [hostsDraft, setHostsDraft] = useState<HostDraft[] | null>(null);
  // Inputs keep their own text, so they remount with the saved values after a save or a discard.
  const [generation, setGeneration] = useState(0);
  // The saved revision the inputs show; it follows new saves only while nothing is being edited (as in Branch names).
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const revision = settings.status === "ready" ? settings.revision : null;
  const editing = hostMode !== null || hostTemplate !== null || hostsDraft !== null || Object.keys(projectDrafts).length > 0;
  useEffect(() => { if (revision !== null && !editing) setBaseRevision(revision); }, [revision, editing]);
  if (settings.status !== "ready") {
    return <SettingsSection title="Delivery">
      <SettingsRow label={settings.status === "loading" ? "Loading…" : "Delivery settings can't be read"} error={settings.status === "loading" ? null : settings.error} />
    </SettingsSection>;
  }
  const saved = settings.values;
  const mode = hostMode ?? saved.mode;
  const template = (hostTemplate ?? saved.titleTemplate).trim();
  const savedHosts: HostDraft[] = saved.forgeHosts.map((entry, index) => ({ ...entry, key: `saved-${index}` }));
  const hosts = hostsDraft ?? savedHosts;
  const cleanHosts = hosts.map(({ match, forge, host: web }) => ({ match: match.trim(), forge, host: web.trim() }));
  const projectMode = (id: string): ProjectMode => projectDrafts[id]?.mode ?? saved.projects[id]?.mode ?? "host";
  const projectTemplate = (id: string) => (projectDrafts[id]?.titleTemplate ?? saved.projects[id]?.titleTemplate ?? "").trim();
  const projectForge = (id: string): ProjectForge => projectDrafts[id]?.forge ?? saved.projects[id]?.forge ?? "detect";
  const problems = [pullRequestTitleProblem(template), ...Object.keys(projectDrafts).map(id => pullRequestTitleProblem(projectTemplate(id))), ...cleanHosts.map(entry => hostProblem(entry, cleanHosts))];
  const hostsChanged = JSON.stringify(cleanHosts) !== JSON.stringify(saved.forgeHosts);
  const changed = mode !== saved.mode || template !== saved.titleTemplate.trim() || hostsChanged
    || Object.keys(projectDrafts).some(id => projectMode(id) !== (saved.projects[id]?.mode ?? "host") || projectTemplate(id) !== (saved.projects[id]?.titleTemplate ?? "").trim()
      || projectForge(id) !== (saved.projects[id]?.forge ?? "detect"));
  const conflict = editing && baseRevision !== null && baseRevision !== settings.revision;
  const draftProject = (id: string, patch: ProjectDraft) => setProjectDrafts(drafts => ({ ...drafts, [id]: { ...drafts[id], ...patch } }));
  const draftHost = (key: string, patch: Partial<ForgeHostMapping>) => setHostsDraft((hostsDraft ?? savedHosts).map(entry => entry.key === key ? { ...entry, ...patch } : entry));
  const discard = () => { setHostMode(null); setHostTemplate(null); setProjectDrafts({}); setHostsDraft(null); setGeneration(value => value + 1); };

  async function save() {
    if (settings.status !== "ready" || conflict) return;
    const overrides = { ...settings.values.projects };
    for (const id of Object.keys(projectDrafts)) {
      const forge = projectForge(id);
      const next = {
        ...(projectMode(id) !== "host" ? { mode: projectMode(id) as DeliveryMode } : {}),
        ...(projectTemplate(id) ? { titleTemplate: projectTemplate(id) } : {}),
        ...(forge !== "detect" ? { forge } : {}),
      };
      if (Object.keys(next).length) overrides[id] = next; else delete overrides[id];
    }
    if (await settings.save({ ...settings.values, mode, titleTemplate: template, projects: overrides, forgeHosts: cleanHosts }, settings.revision)) discard();
  }

  const titleHint = (value: string, fallback: string) => {
    const used = value || fallback;
    return `Tokens: {ticket} (the ticket key), {title} (the ticket's or task's title), {slug}, {type} and {id}, as in branch names. A task without a ticket drops {ticket} and the separator beside it. Example: ${examplePullRequestTitle(used)}`;
  };

  return <>
    <SettingsSection title="Delivery" info="How Attention's Ready list delivers an approved task. Merge merges the task branch into the main checkout, for personal projects. Pull request commits the task's work, pushes only the task branch (never forced) and opens a draft pull request on GitHub, Azure DevOps or Bitbucket Cloud against the project's default branch. It never merges the pull request; once it merges, Attention offers Clean up.">
      <SettingsSelect label="Default for this host" hint="Projects without an override use this." value={mode} options={hostModes} onValueChange={value => setHostMode(value)} />
      <SettingsInput key={`title-${baseRevision}-${generation}`} label="Pull request title" hint={titleHint(template, defaultPullRequestTitle)}
        initialValue={saved.titleTemplate} placeholder={defaultPullRequestTitle} onChangeText={setHostTemplate} error={pullRequestTitleProblem(template)} />
    </SettingsSection>
    <SettingsSection title="Per project" info="An override replaces the host's delivery or title template for one project. The pull request targets the project's default branch (Workspaces tab), else origin's HEAD branch. Forge shows where origin is: detected from its URL, mapped by a custom host below, or set here for a host neither knows. A project's forge setting wins.">
      {projects.isPending ? <SettingsRow label="Loading projects…" /> : null}
      {projects.error ? <SettingsRow label="Projects can't be listed" error={projects.error instanceof Error ? projects.error.message : String(projects.error)} /> : null}
      {projects.data && !projects.data.length ? <SettingsRow label="No Git projects on this host" /> : null}
      {projects.data?.map(project => {
        const value = projectMode(project.projectId);
        const effective = value === "host" ? mode : value;
        const own = projectTemplate(project.projectId);
        const forge = projectForge(project.projectId);
        // Detection as Open PR will do it, with the settings being edited.
        const repo = project.remote ? detectForge(project.remote, { hosts: cleanHosts, ...(forge !== "detect" ? { override: forge } : {}) }) : null;
        const where = project.error ? `origin couldn't be read: ${project.error}` : !project.remote ? "No origin remote."
          : repo ? `${forgeLabels[repo.forge]} · ${repo.slug} (${forgeSourceLabels[repo.source]}). origin: ${project.remote}`
            : `Unknown. origin: ${project.remote}${forge === "detect" ? " — map its host below, or choose its forge here." : ` doesn't have a ${forgeLabels[forge]} repository path.`}`;
        return <View key={project.projectId}>
          <SettingsSelect label={project.name} hint={value === "host" ? `Uses the host default: ${deliveryModeLabels[mode]}.` : `${deliveryModeLabels[value]} for this project.`}
            value={value} options={[{ label: `Host default (${deliveryModeLabels[mode]})`, value: "host" }, ...hostModes]} onValueChange={next => draftProject(project.projectId, { mode: next })} />
          <SettingsSelect label={`${project.name} · forge`} hint={where}
            value={forge} options={[{ label: repo && forge === "detect" ? `Detect (${forgeLabels[repo.forge]})` : "Detect", value: "detect" }, ...forgeOptions]}
            onValueChange={next => draftProject(project.projectId, { forge: next })} />
          {effective === "pull-request" ? <SettingsInput key={`${project.projectId}-${baseRevision}-${generation}`} label={`${project.name} · title`}
            hint={own ? titleHint(own, own) : `Uses the host's: ${template || defaultPullRequestTitle}`} initialValue={saved.projects[project.projectId]?.titleTemplate ?? ""}
            placeholder={template || defaultPullRequestTitle} onChangeText={text => draftProject(project.projectId, { titleTemplate: text })} error={pullRequestTitleProblem(own)} /> : null}
        </View>;
      })}
    </SettingsSection>
    <SettingsSection title="Custom hosts" info="Hosts detection doesn't know, mapped to a forge for every project on this host: a GitHub Enterprise domain, an Azure DevOps Server, or an SSH host alias from ~/.ssh/config such as github-work in git@github-work:org/repo.git. Web address is the forge's own address when origin's URL doesn't give it (an SSH alias, or an SSH remote of a server on another scheme or port); leave it empty for an http(s) remote, or for an alias of github.com, dev.azure.com or bitbucket.org.">
      {!hosts.length ? <SettingsRow label="No custom hosts" hint="github.com, dev.azure.com, *.visualstudio.com and bitbucket.org are detected without one." /> : null}
      {hosts.map((entry, index) => <View key={`${entry.key}-${generation}`}>
        <SettingsInput label={`Host ${index + 1}`} hint="As it appears in origin's URL, such as github.example.com or github-work." initialValue={entry.match} placeholder="github.example.com"
          onChangeText={text => draftHost(entry.key, { match: text })} error={hostProblem(cleanHosts[index], cleanHosts)} />
        <SettingsSelect label={`Host ${index + 1} · forge`} value={entry.forge} options={forgeOptions} onValueChange={next => draftHost(entry.key, { forge: next })} />
        <SettingsInput label={`Host ${index + 1} · web address`} hint="Optional. The forge's own address when origin's URL doesn't give it: github.com for an alias of GitHub, or a base URL such as http://tfs.corp:8080 for an SSH remote of an Azure DevOps Server. An http(s) remote keeps its own scheme and port." initialValue={entry.host} placeholder="(from origin's URL)"
          onChangeText={text => draftHost(entry.key, { host: text })} />
        <SettingsAction label={`Remove host ${index + 1}`} actionLabel="Remove" onPress={() => setHostsDraft(hosts.filter(other => other.key !== entry.key))} />
      </View>)}
      <SettingsAction label="Add a custom host" actionLabel="Add" disabled={hosts.length >= 50}
        onPress={() => setHostsDraft([...hosts, { key: `new-${Date.now()}-${hosts.length}`, match: "", forge: "github", host: "" }])} />
    </SettingsSection>
    <SettingsSection title="Save">
      <SettingsAction label={changed ? "Unsaved changes" : "Saved"}
        hint={settings.saving ? "Saving…" : "Attention uses these for approved tasks on this host. Setup shows gh, az and Bitbucket credentials for the forges these projects use."}
        error={conflict ? "Delivery settings were saved elsewhere while you were editing. Discard your changes to see the new values, then edit again." : settings.saveError}
        actionLabel={settings.saving ? "Saving…" : "Save delivery"} disabled={!changed || conflict || settings.saving || problems.some(Boolean)} onPress={() => void save()} />
      {changed || conflict ? <SettingsAction label="Discard changes" actionLabel="Discard" disabled={settings.saving} onPress={discard} /> : null}
    </SettingsSection>
  </>;
}
