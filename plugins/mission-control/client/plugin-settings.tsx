import { CompactExternalLink } from "./compact-link";
import { usePaseo, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ExternalLink, SettingsAction, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { CompactLink } from "./compact-link";
import { ProjectGitSettingsControls } from "./project-git";
import { applyPluginUpdate, checkPluginUpdate, type PluginSource, type PluginUpdateStatus } from "../shared/plugin-updates";
import { formatDateTime } from "./date-time";
import { followsUpdate, lastUpdateNotice, updateLogHint } from "./plugin-update-view";

const UPDATE_BUDGET_MS = 5 * 60_000;
const short = (revision: string | null) => revision ? revision.slice(0, 7) : "unknown";

function sourceRow(source: PluginSource | null): { value: string; hint: string } {
  if (!source) return { value: "Unknown", hint: "Paseo did not report where Mission Control was installed from." };
  if (source.kind === "directory") return { value: "Folder on this host", hint: source.path };
  if (source.kind === "git") return { value: "Git", hint: source.pluginPath ? `${source.remote} · ${source.pluginPath}` : source.remote };
  if (source.kind === "npm") return { value: "npm", hint: source.name ?? "npm package" };
  return { value: source.label, hint: "Installed by Paseo." };
}

function updateSummary(status: PluginUpdateStatus): { label: string; hint: string } {
  switch (status.state) {
    case "update": return { label: "Update available", hint: `${short(status.current)} → ${short(status.target)}` };
    case "current": return { label: "Up to date", hint: status.source?.kind === "git" ? `Commit ${short(status.current)} is the latest on the repository's default branch.` : `${short(status.current)} is the latest version.` };
    case "installed-newer": return { label: "Newer than the latest release", hint: `Installed ${short(status.current)} is newer than ${short(status.target)}; keeping it.` };
    case "local": return {
      label: "Updates come from Git",
      hint: "Mission Control runs from a folder on this host, so Paseo can't update it. To get changes, pull them into that folder, then choose Reload for Mission Control in Settings → Plugins. For one-click updates, reinstall it from its GitHub repository (see the plugin README).",
    };
    default: return { label: "Couldn't check for updates", hint: "" };
  }
}

/** Settings → Plugins → Mission Control: version, install source, and updates through Paseo's `plugin update`. */
export function PluginSettings({ host, theme }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const projects = useQuery({ queryKey: ["mission-control", "git-settings-projects", host.id], queryFn: async () => (await paseo.projects.list()).projects.filter(project => project.projectKind === "git").map(project => ({ id: project.projectId, name: project.projectCustomName || project.projectDisplayName })), retry: false });
  const selectedProject = projects.data?.find(project => project.id === selectedProjectId) ?? projects.data?.[0];
  const check = useRpc(checkPluginUpdate);
  const apply = useRpc(applyPluginUpdate);
  const [confirming, setConfirming] = useState(false);
  const [updatingSince, setUpdatingSince] = useState<number | null>(null);
  // When the last update stopped being followed without a result.
  const [timedOutAt, setTimedOutAt] = useState<number | null>(null);
  const status = useQuery({
    queryKey: ["mission-control", "plugin-update", host.id], queryFn: () => check({}), retry: false, refetchOnWindowFocus: false,
    // The plugin reloads mid-update, so failed checks are expected for a moment; keep rechecking.
    refetchInterval: updatingSince !== null ? 5000 : false,
  });
  const start = useMutation({ mutationFn: (target: string) => apply({ target }), onSuccess: () => { setConfirming(false); setTimedOutAt(null); setUpdatingSince(Date.now()); } });
  const data = status.data;
  // An update started from another screen or device: follow it the same way, from the check that reported it.
  useEffect(() => {
    if (updatingSince === null && followsUpdate(data?.updating, status.dataUpdatedAt, timedOutAt)) setUpdatingSince(status.dataUpdatedAt);
  }, [data?.updating, status.dataUpdatedAt, updatingSince, timedOutAt]);
  // Done when a check made after the start says no update is running: the reloaded plugin, or the old one reporting a failure.
  useEffect(() => {
    if (updatingSince !== null && data && !data.updating && status.dataUpdatedAt > updatingSince) setUpdatingSince(null);
  }, [data, status.dataUpdatedAt, updatingSince]);
  useEffect(() => {
    if (updatingSince === null) return;
    const timer = setTimeout(() => { setUpdatingSince(null); setTimedOutAt(Date.now()); }, Math.max(0, updatingSince + UPDATE_BUDGET_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [updatingSince]);
  useEffect(() => { setConfirming(false); }, [data?.target]);
  const updating = updatingSince !== null;
  const notice = lastUpdateNotice({ updating, checking: status.isFetching, lastUpdateError: data?.lastUpdateError, timedOutAt, checkedAt: status.dataUpdatedAt });
  const colors = theme.colors;
  const source = data ? sourceRow(data.source) : null;
  const summary = data ? updateSummary(data) : null;
  const version = data ? `${data.version}${data.source?.kind === "git" && data.current ? ` · ${short(data.current)}` : ""}` : "…";

  return <>
    <SettingsSection title="Project Git" info="Default branch overrides and automatic fetch are saved per project on this host. These existing preferences apply wherever Mission Control displays that project; native Paseo workspace preferences are unchanged.">
      {projects.isPending ? <SettingsRow label="Loading Git projects…" /> : null}
      {projects.isError ? <SettingsRow label="Git projects unavailable" error={projects.error instanceof Error ? projects.error.message : String(projects.error)} /> : null}
      {projects.isSuccess && !projects.data.length ? <SettingsRow label="No Git projects on this host" /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{projects.data?.map(project => <CompactLink key={project.id} label={project.name} selected={selectedProject?.id === project.id} colors={colors} onPress={() => setSelectedProjectId(project.id)} />)}</View>
      {selectedProject ? <ProjectGitSettingsControls key={`${host.id}:${selectedProject.id}`} projectId={selectedProject.id} projectName={selectedProject.name} local colors={colors} /> : null}
    </SettingsSection>
    <SettingsSection title="Installed">
      <SettingsRow label="Version" hint={`Mission Control on ${host.label}`}><Text style={{ color: colors.foreground }}>{version}</Text></SettingsRow>
      {source && <SettingsRow label="Source" hint={source.hint}><Text style={{ color: colors.foreground }}>{source.value}</Text></SettingsRow>}
    </SettingsSection>
    <SettingsSection title="Updates">
      <SettingsAction
        label={updating ? "Updating…" : status.isFetching && !data ? "Checking for updates…" : summary?.label ?? "Couldn't check for updates"}
        hint={updating
          ? "Paseo is downloading, building and reloading Mission Control. This page may disconnect briefly; it rechecks on its own."
          : [summary?.hint, data && `Checked ${formatDateTime(data.checkedAt)}.`].filter(Boolean).join(" ")}
        error={updating ? null : status.error?.message ?? (data?.state === "error" || data?.state === "unavailable" ? data.error ?? "The update check failed." : null)}
        actionLabel={status.isFetching && !updating ? "Checking…" : "Check for updates"}
        // A check that finishes after the update starts would end "Updating…" too early.
        disabled={status.isFetching || updating || start.isPending}
        onPress={() => { void status.refetch(); }}
      />
      {notice && <SettingsRow label="Last update didn't finish" hint={updateLogHint} error={notice} />}
      {data?.state === "update" && !updating && data.links[0] && <SettingsRow label="Changes" hint="Opens the list of changes in this update.">
        <CompactExternalLink colors={colors} label={"Review changes"} href={data.links[0]} accessibilityLabel="Review Mission Control's changes" />
      </SettingsRow>}
      {data?.state === "update" && !updating && data.target && (!confirming
        ? <SettingsAction label="Update Mission Control" hint={`Installs ${short(data.target)} on ${host.label} with Paseo's plugin update. Its dependencies (kit, skills, tools) and your vault are not changed.`}
            actionLabel="Update" onPress={() => setConfirming(true)} />
        : <>
          <SettingsAction label={`Update Mission Control on ${host.label}?`}
            hint="Runs paseo plugin update mission-control. Paseo downloads, builds and reloads the plugin for every client of this host."
            error={start.error?.message ?? null}
            actionLabel={start.isPending ? "Starting…" : "Confirm update"} disabled={start.isPending || status.isFetching} onPress={() => start.mutate(data.target!)} />
          <SettingsAction label="Keep the current version" actionLabel="Cancel" disabled={start.isPending} onPress={() => { setConfirming(false); start.reset(); }} />
        </>)}
    </SettingsSection>
  </>;
}
