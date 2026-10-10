import { CompactLink } from "./compact-link";
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { branchNameSchema, getProjectGitStatus, projectGitSettings, pullProjectLatest, type ProjectGitEntry, type ProjectGitStatus } from "../shared/project-git";

type Colors = PluginSurfaceProps["theme"]["colors"];
type Props = { projectId: string; projectName: string; colors: Colors; local: boolean };
const autoFetchInterval = 10 * 60_000;
const commits = (count: number) => `${count} commit${count === 1 ? "" : "s"}`;

/** The main checkout against origin's default branch, shown once this host has fetched it. */
function describePosition(git: ProjectGitStatus) {
  if (!git.hasOrigin || !git.fetchedAt || git.ahead === null || git.behind === null) return null;
  const remote = `origin/${git.defaultBranch}`;
  const where = git.branch && git.branch !== git.defaultBranch ? `Main checkout (on ${git.branch})` : "Main checkout";
  if (git.ahead && git.behind) return `${where} has diverged from ${remote}: ${commits(git.behind)} behind, ${commits(git.ahead)} ahead`;
  if (git.behind) return `${where} is ${commits(git.behind)} behind ${remote}`;
  if (git.ahead) return `${where} is ${commits(git.ahead)} ahead of ${remote}`;
  return `${where} is up to date with ${remote}`;
}

/** Default branch, automatic fetch and Pull latest for one project. RPCs and settings exist only on this installation's host. */
export function ProjectGit(props: Props) {
  return props.local ? <ProjectGitBar {...props} /> : null;
}

export function ProjectGitSettingsControls(props: Props) {
  return props.local ? <ProjectGitBar {...props} settingsMode /> : null;
}

function ProjectGitBar({ projectId, projectName, colors, settingsMode = false }: Props & { settingsMode?: boolean }) {
  const settings = useSettings(projectGitSettings);
  const readStatus = useRpc(getProjectGitStatus);
  const pull = useRpc(pullProjectLatest);
  const entry: ProjectGitEntry = settings.status === "ready" ? settings.values.projects[projectId] ?? { autoFetch: false } : { autoFetch: false };
  const status = useQuery({
    queryKey: ["mission-control", "project-git", projectId, entry.defaultBranch ?? "", entry.autoFetch],
    queryFn: () => readStatus({ projectId, fetch: entry.autoFetch }),
    enabled: settings.status === "ready",
    refetchInterval: entry.autoFetch ? autoFetchInterval : false,
    staleTime: 60_000, retry: false,
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [result, setResult] = useState<{ outcome: string; message: string } | null>(null);
  const [pulling, setPulling] = useState(false);
  const [autoFetchHovered, setAutoFetchHovered] = useState(false);
  const [autoFetchFocused, setAutoFetchFocused] = useState(false);
  const pending = useRef(false);
  const git: ProjectGitStatus | undefined = status.data;
  const autoFetchDisabled = settings.status !== "ready" || settings.saving || !git?.hasOrigin;
  const settingsError = settings.saveError ?? ((settings.status === "error" || settings.status === "invalid") ? settings.error : null);

  async function save(next: ProjectGitEntry) {
    if (settings.status !== "ready") return false;
    const projects = { ...settings.values.projects, [projectId]: next };
    return settings.save({ ...settings.values, projects }, settings.revision);
  }
  async function saveBranch(value: string) {
    const trimmed = value.trim();
    let defaultBranch: string | undefined;
    if (trimmed) {
      const parsed = branchNameSchema.safeParse(trimmed);
      if (!parsed.success) { setDraftError(parsed.error.issues[0]?.message ?? "Invalid branch name."); return; }
      defaultBranch = parsed.data;
    }
    const { defaultBranch: _previous, ...rest } = entry;
    if (await save(defaultBranch ? { ...rest, defaultBranch } : rest)) { setEditing(false); setDraftError(null); setResult(null); }
  }
  async function pullLatest() {
    if (pending.current) return;
    pending.current = true; setPulling(true); setResult(null);
    try {
      const outcome = await pull({ projectId });
      setResult({ outcome: outcome.outcome, message: outcome.message });
      await status.refetch();
    } catch (error) {
      setResult({ outcome: "failed", message: error instanceof Error ? error.message : String(error) });
    } finally { pending.current = false; setPulling(false); }
  }

  const branchLabel = git?.defaultBranch
    ? `${git.defaultBranch}${git.defaultSource === "origin" ? " (origin's default)" : ""}`
    : entry.defaultBranch ?? (status.isPending ? "…" : "unknown");
  const position = git ? describePosition(git) : null;
  const resultColor = result?.outcome === "updated" || result?.outcome === "current" ? colors.statusSuccess : result?.outcome === "failed" ? colors.statusDanger : colors.statusWarning;

  const autoFetchLabel = settings.status === "ready" ? (entry.autoFetch ? "on" : "off") : settings.status === "error" || settings.status === "invalid" ? "unavailable" : "loading";
  if (!settingsMode) return <View style={{ gap: 5 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <Icon name="GitBranch" size={14} color={colors.foregroundMuted} />
      <Text selectable accessibilityLabel={`Default branch for ${projectName}: ${git?.defaultBranch ?? entry.defaultBranch ?? "unavailable"}`} style={{ color: colors.foregroundMuted, fontSize: 12 }}>{git?.defaultBranch ?? entry.defaultBranch ?? (status.isPending ? "…" : "Unavailable")}</Text>
      <CompactLink iconOnly label={pulling ? "Pulling latest…" : `Pull latest for ${projectName}`} icon="RefreshCw" colors={colors} disabled={pulling || !git?.hasOrigin} accessibilityHint="Fetches origin, then fast-forwards the main checkout only when it is on the default branch and clean." onPress={() => void pullLatest()} />
      <View accessible accessibilityRole="image" accessibilityLabel={`Auto-fetch ${autoFetchLabel} for ${projectName}`} {...(Platform.OS === "web" ? { title: `Auto-fetch ${autoFetchLabel} for ${projectName}` } : {})}>
        <Icon name={settings.status !== "ready" ? "CircleHelp" : entry.autoFetch ? "CircleCheck" : "CircleMinus"} size={14} color={settings.status === "ready" && entry.autoFetch ? colors.accent : colors.foregroundMuted} />
      </View>
    </View>
    {settingsError ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning, fontSize: 12 }}>Git settings: {String(settingsError)}</Text> : null}
    {status.error || git?.fetchError ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning, fontSize: 12 }}>{status.error instanceof Error ? status.error.message : git?.fetchError ?? String(status.error)}</Text> : null}
    {result ? <Text accessibilityLiveRegion="polite" style={{ color: resultColor, fontSize: 12 }}>{result.message}</Text> : null}
  </View>;

  return <View style={{ gap: 6, paddingHorizontal: 10 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <Icon name="GitBranch" size={14} color={colors.foregroundMuted} />
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Default branch: <Text style={{ color: colors.foreground }}>{branchLabel}</Text></Text>
      {git && !git.hasOrigin ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No origin remote. New task worktrees start from the current branch.</Text> : null}
      {position ? <Text style={{ color: git?.behind ? colors.statusWarning : colors.foregroundMuted, fontSize: 12 }}>{position}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginLeft: "auto" }}>
        <CompactLink colors={colors} label={(editing ? "Cancel" : "Change")} accessibilityRole="button" accessibilityLabel={`Change the default branch for ${projectName}`} disabled={settings.status !== "ready"} onPress={() => { setEditing(!editing); setDraft(entry.defaultBranch ?? ""); setDraftError(null); }} />
        <Pressable accessibilityRole="switch" accessibilityState={{ checked: entry.autoFetch }} accessibilityLabel={`Fetch ${projectName} from origin automatically`}
          disabled={autoFetchDisabled} onPress={() => void save({ ...entry, autoFetch: !entry.autoFetch })}
          onHoverIn={() => setAutoFetchHovered(true)} onHoverOut={() => setAutoFetchHovered(false)}
          onFocus={() => setAutoFetchFocused(true)} onBlur={() => setAutoFetchFocused(false)}
          style={({ pressed }) => ({
            minHeight: Platform.OS === "web" ? 32 : 44, paddingHorizontal: 9, paddingVertical: 4,
            flexDirection: "row", alignItems: "center", justifyContent: "center", alignSelf: "flex-start", gap: 5,
            borderWidth: 1, borderRadius: 6, borderColor: !autoFetchDisabled && autoFetchFocused ? colors.accent : colors.border,
            backgroundColor: !autoFetchDisabled && pressed ? colors.surface2 : !autoFetchDisabled && autoFetchHovered ? colors.surface1 : "transparent",
            opacity: autoFetchDisabled ? 0.45 : 1, flexShrink: 1,
          })}>
          <Icon name="RefreshCw" size={13} color={autoFetchDisabled ? colors.foregroundMuted : colors.foreground} />
          <Text style={{ color: autoFetchDisabled ? colors.foregroundMuted : colors.foreground, fontSize: 12, fontWeight: "500", flexShrink: 1 }}>Auto-fetch: {entry.autoFetch ? "On" : "Off"}</Text>
        </Pressable>
        <CompactLink colors={colors} label={(pulling ? "Pulling…" : "Pull latest")} accessibilityRole="button" accessibilityLabel={`Pull latest for ${projectName}`} accessibilityHint="Fetches origin, then fast-forwards the main checkout only when it is on the default branch and clean." disabled={pulling || (git ? !git.hasOrigin : true)} onPress={() => void pullLatest()} />
      </View>
    </View>
    {editing ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <TextInput accessibilityLabel={`Default branch for ${projectName}`} value={draft} onChangeText={value => { setDraft(value); setDraftError(null); }}
        placeholder={git?.defaultSource === "origin" && git.defaultBranch ? `origin's default (${git.defaultBranch})` : "origin's default"} placeholderTextColor={colors.foregroundMuted}
        autoCapitalize="none" autoCorrect={false} onSubmitEditing={() => void saveBranch(draft)}
        style={{ flex: 1, minWidth: 160, minHeight: 44, paddingHorizontal: 10, borderRadius: 7, borderWidth: 1, borderColor: draftError ? colors.statusDanger : colors.border, color: colors.foreground, backgroundColor: colors.surface0 }} />
      <CompactLink colors={colors} label={"Save"} accessibilityRole="button" disabled={settings.saving} onPress={() => void saveBranch(draft)} />
      <CompactLink colors={colors} label={"Use origin's default"} accessibilityRole="button" disabled={settings.saving || !entry.defaultBranch} onPress={() => void saveBranch("")} />
    </View> : null}
    {draftError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{draftError}</Text> : null}
    {settings.saving ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 11 }}>Saving…</Text> : null}
    {settingsError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>Project Git settings: {String(settingsError)}</Text> : null}
    {git?.fetchError ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning, fontSize: 12 }}>{git.fetchError}</Text> : null}
    {status.error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>Git status: {status.error instanceof Error ? status.error.message : String(status.error)}</Text> : null}
    {result ? <Text accessibilityLiveRegion="polite" style={{ color: resultColor, fontSize: 12 }}>{result.message}</Text> : null}
  </View>;
}
