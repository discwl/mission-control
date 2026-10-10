import { CompactExternalLink } from "./compact-link";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ExternalLink, SettingsAction, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import {
  applySetupAction,
  planSetupAction,
  readSetup,
  setupStatusLabels,
  type SetupAction,
  type SetupItem,
  type SetupPlan,
  type SetupReport,
  type SetupResult,
  type SetupStatus,
  type SkillGroup,
} from "../shared/setup";
import { formatDateTime } from "./date-time";

type Colors = PluginSurfaceProps["theme"]["colors"];

const errorText = (error: unknown) => error instanceof Error ? error.message : error ? String(error) : null;
const CHANGES: Record<SetupPlan["changes"][number]["change"], string> = {
  "create-link": "Create link", "replace-link": "Re-point link", "write-file": "Write file", "update-file": "Replace file", "run-command": "Run", skip: "Leave as it is",
};

function statusColor(status: SetupStatus, optional: boolean, colors: Colors) {
  if (status === "installed") return colors.statusSuccess;
  if (status === "outdated" || status === "modified") return colors.statusWarning;
  if (status === "missing" && !optional) return colors.statusDanger;
  return colors.foregroundMuted;
}

function Status({ status, optional = false, colors, children }: { status: SetupStatus; optional?: boolean; colors: Colors; children?: ReactNode }) {
  return <View style={{ alignItems: "flex-end", gap: 2, maxWidth: 240 }}>
    <Text style={{ color: statusColor(status, optional, colors), textAlign: "right" }}>{setupStatusLabels[status]}{optional && status === "missing" ? " (optional)" : ""}</Text>
    {children}
  </View>;
}

/**
 * An install: plan, confirm, apply, then show the result. The report is re-read after each attempt. An install that
 * outlasts the server's reply window (npm on a slow network) is followed through the report until its result arrives,
 * the way Start task follows a slow launch.
 */
function useSetupAction(report: { data: SetupReport | undefined }, onChanged: () => void) {
  const plan = useRpc(planSetupAction);
  const apply = useRpc(applySetupAction);
  // Which row asked, so the confirmation and result show under it.
  const [anchor, setAnchor] = useState<string | null>(null);
  const [pending, setPending] = useState<SetupPlan | null>(null);
  const [done, setDone] = useState<SetupResult | null>(null);
  // An install still running on the server. Its start time (server clock) identifies its result.
  const [following, setFollowing] = useState<{ action: SetupAction; startedAt: string; title: string } | null>(null);
  const planning = useMutation({ mutationFn: (action: SetupAction) => plan(action), onSuccess: setPending });
  const applying = useMutation({
    mutationFn: (confirmed: SetupPlan) => apply({ action: confirmed.action, fingerprint: confirmed.fingerprint }).then(result => ({ result, title: confirmed.title })),
    onSuccess: ({ result, title }) => {
      setPending(null);
      if (result.running) setFollowing({ action: result.action, startedAt: result.startedAt, title });
      else setDone(result);
    },
    onSettled: onChanged,
  });
  useEffect(() => {
    const data = report.data;
    if (!following || !data) return;
    if (data.lastResult?.startedAt === following.startedAt) { setDone(data.lastResult); setFollowing(null); return; }
    // A report the server made before the install started says nothing about it; both times are the server's.
    if (data.running?.startedAt === following.startedAt || data.checkedAt < following.startedAt) return;
    // Neither running nor finished here: the plugin server restarted mid-install. The log may still have its result.
    setDone({ action: following.action, running: false, startedAt: following.startedAt, ok: false, summary: `${following.title} stopped reporting before it finished.`, changes: ["Check again, and see Recent installs for what happened."], output: null });
    setFollowing(null);
  }, [report.data, following]);
  const reset = () => { planning.reset(); applying.reset(); };
  return {
    anchor, pending, done, following,
    /** A request is in flight. */
    working: planning.isPending || applying.isPending,
    /** Install buttons wait: a request is in flight, or an install is running on this host from any screen. */
    busy: planning.isPending || applying.isPending || !!following || !!report.data?.running,
    error: errorText(planning.error) ?? errorText(applying.error),
    request(key: string, action: SetupAction) { reset(); setDone(null); setPending(null); setAnchor(key); planning.mutate(action); },
    confirm() { if (pending) applying.mutate(pending); },
    cancel() { reset(); setPending(null); setAnchor(null); },
    dismiss() { reset(); setDone(null); setAnchor(null); },
  };
}
type Installer = ReturnType<typeof useSetupAction>;

/** The confirmation, error or result for the row with this key. */
function InstallRows({ at, installer, hostLabel }: { at: string; installer: Installer; hostLabel: string }) {
  if (installer.anchor !== at) return null;
  const { pending, done } = installer;
  const rows: ReactNode[] = [];
  if (installer.error) rows.push(<SettingsAction key="error" label="Nothing was installed" error={installer.error} actionLabel="OK" onPress={installer.cancel} />);
  if (installer.working && !pending) rows.push(<SettingsRow key="planning" label="Checking what would change…" />);
  if (pending) {
    const acting = pending.changes.filter(change => change.change !== "skip");
    rows.push(<SettingsRow key="plan" label={`${pending.title} on ${hostLabel}?`}
      hint={[pending.command && `Command: ${pending.command}`, pending.blocked ?? `${acting.length} change${acting.length === 1 ? "" : "s"}; nothing else is touched. It checks again just before changing anything, and stops if something changed since now.`].filter(Boolean).join(" · ")} />);
    for (const change of pending.changes) rows.push(<SettingsRow key={change.path} label={`${CHANGES[change.change]}: ${change.path}`} hint={change.detail} />);
    if (!pending.blocked) rows.push(<SettingsAction key="confirm" label="Make these changes" actionLabel={installer.working ? "Working…" : pending.action.kind === "ocr-cli" ? "Run" : "Install"} disabled={installer.working} onPress={installer.confirm} />);
    rows.push(<SettingsAction key="cancel" label={pending.blocked ? "Nothing to do" : "Leave everything as it is"} actionLabel={pending.blocked ? "OK" : "Cancel"} disabled={installer.working} onPress={installer.cancel} />);
  }
  if (installer.following) rows.push(<SettingsRow key="following" label={`${installer.following.title}: still running…`} hint="It carries on on the server. This page checks every few seconds and shows the result here when it finishes." />);
  if (done && !pending) {
    const hint = [...done.changes, done.output && `Output: ${done.output}`, done.action.kind === "skills" && done.ok && "Start a new agent session to pick up new skills."].filter(Boolean).join(" · ");
    rows.push(<SettingsAction key="done" label={done.summary} hint={hint} error={done.ok ? null : "Not everything finished; see the details."} actionLabel="OK" onPress={installer.dismiss} />);
  }
  return <>{rows}</>;
}

function helpHint(item: SetupItem) {
  return [item.version && `Version ${item.version}`, item.expected, item.detail, item.help.text, item.help.command && `Command: ${item.help.command}`].filter(Boolean).join(" · ");
}

function ItemRow({ item, colors, installer, hostLabel, action }: { item: SetupItem; colors: Colors; installer: Installer; hostLabel: string; action?: SetupAction }) {
  const canInstall = !!action && item.installable && (item.status === "missing" || item.status === "outdated");
  const link = item.help.link ? <CompactExternalLink colors={colors} label={"Open link"} href={item.help.link} accessibilityLabel={`${item.name}: how to install or update`} /> : null;
  return <>
    {canInstall
      ? <SettingsAction label={`${item.name} · ${setupStatusLabels[item.status]}`} hint={helpHint(item)} actionLabel={item.status === "missing" ? "Install…" : "Update…"}
          disabled={installer.busy} onPress={() => installer.request(item.id, action!)} />
      : <SettingsRow label={item.name} hint={helpHint(item)}><Status status={item.status} optional={item.optional} colors={colors}>{link}</Status></SettingsRow>}
    {item.signIn ? <SettingsRow label={`${item.name} · ${item.signIn.signedIn ? "Signed in" : "Not signed in"}`} hint={item.signIn.detail}>
      <Text style={{ color: item.signIn.signedIn ? colors.statusSuccess : colors.statusWarning, textAlign: "right" }}>{item.signIn.signedIn ? "Signed in" : "Not signed in"}</Text>
    </SettingsRow> : null}
    <InstallRows at={item.id} installer={installer} hostLabel={hostLabel} />
  </>;
}

/** The link that follows the current install across updates, and moving profiles onto it. */
function StableKitRow({ stable, colors, installer, hostLabel }: { stable: NonNullable<SetupReport["kit"]["stable"]>; colors: Colors; installer: Installer; hostLabel: string }) {
  const moving = stable.profilesToMove.length;
  const hint = [stable.path, stable.detail, moving ? `${moving} profile${moving === 1 ? " names" : "s name"} one install's folder, which the next update replaces. Then re-point the skill links.` : null].filter(Boolean).join(" · ");
  return <>
    {moving && stable.status === "installed"
      ? <SettingsAction label="Stable kit path · Profiles to move" hint={hint} actionLabel="Use it…" disabled={installer.busy} onPress={() => installer.request("kit-root", { kind: "kit-root" })} />
      : <SettingsRow label="Stable kit path" hint={hint}><Status status={stable.status} colors={colors} /></SettingsRow>}
    <InstallRows at="kit-root" installer={installer} hostLabel={hostLabel} />
  </>;
}

const GROUP_NAMES: Record<SkillGroup["group"], string> = { "development-flow": "Development Flow skills", "ocr-delegate": "OCR delegate skill" };

function SkillGroupRows({ group, colors, installer, hostLabel }: { group: SkillGroup; colors: Colors; installer: Installer; hostLabel: string }) {
  const [open, setOpen] = useState(false);
  const key = `skills-${group.provider}-${group.group}`;
  const counts = (["installed", "missing", "outdated", "modified", "not-managed"] as const).map(status => [status, group.links.filter(link => link.status === status).length] as const).filter(([, count]) => count);
  const hint = [group.folder, counts.map(([status, count]) => `${count} ${setupStatusLabels[status].toLowerCase()}`).join(", "), group.blocked !== "Nothing to install." && group.blocked].filter(Boolean).join(" · ");
  const label = `${group.providerName} · ${GROUP_NAMES[group.group]}`;
  const canInstall = !group.blocked;
  return <>
    {canInstall
      ? <SettingsAction label={`${label} · ${setupStatusLabels[group.status]}`} hint={hint} actionLabel={group.links.some(link => link.status === "missing") ? "Install…" : "Update…"}
          disabled={installer.busy} onPress={() => installer.request(key, { kind: "skills", provider: group.provider, group: group.group })} />
      : group.links.length
        ? <SettingsAction label={`${label} · ${setupStatusLabels[group.status]}`} hint={hint} actionLabel={open ? "Hide" : "Details"} onPress={() => setOpen(!open)} />
        : <SettingsRow label={label} hint={hint}><Status status={group.status} colors={colors} /></SettingsRow>}
    <InstallRows at={key} installer={installer} hostLabel={hostLabel} />
    {open && !canInstall ? group.links.map(link => <SettingsRow key={link.path} label={link.name} hint={[link.path, `→ ${link.target}`, link.note].filter(Boolean).join(" · ")}>
      <Status status={link.status} colors={colors} />
    </SettingsRow>) : null}
  </>;
}

/**
 * Settings → Plugins → Mission Control → Setup: each dependency's status on the selected host. The only changes it makes,
 * each after a confirmation, are skill links, the pinned OCR CLI and OCR rule files.
 */
export function SetupSettings({ host, theme }: PluginSurfaceProps) {
  const read = useRpc(readSetup);
  const [followingInstall, setFollowingInstall] = useState(false);
  const report = useQuery({
    queryKey: ["mission-control", "setup", host.id], queryFn: () => read({}),
    retry: false, refetchOnWindowFocus: false, staleTime: 60_000,
    // While an install runs on this host, from this screen or another, keep checking until it finishes.
    refetchInterval: query => followingInstall || query.state.data?.running ? 5000 : false,
  });
  const installer = useSetupAction({ data: report.data }, () => void report.refetch());
  useEffect(() => { setFollowingInstall(!!installer.following); }, [installer.following]);
  const colors = theme.colors;
  const data = report.data;
  const rules = data?.tools.find(item => item.id === "ocr-rules");

  return <>
    <SettingsSection title="Setup" info={`What Mission Control needs on ${host.label}, and whether each piece is there. It changes only four things, each after you confirm: skill links, the OpenCode Review CLI at its pinned version, OCR rule files, and moving project profiles onto the stable kit path. Everything else shows its version and the command or link to use yourself. Nothing is started or signed in to.`}>
      <SettingsAction label={report.isFetching ? "Checking this host…" : data ? `Checked ${formatDateTime(data.checkedAt)}` : "Not checked yet"}
        hint={`Reads files and runs version commands (node, git, gh, az, gortex, Paseo) on ${host.label}, plus gh auth status, az account show and a prompt-free git credential lookup for bitbucket.org, which only report whether you're signed in.`} error={errorText(report.error)}
        actionLabel={report.isFetching ? "Checking…" : "Check again"} disabled={report.isFetching || installer.working} onPress={() => void report.refetch()} />
      {data?.running && !installer.following ? <SettingsRow label={`Installing on ${host.label}: ${data.running.title}`} hint={`Started ${formatDateTime(data.running.startedAt)}. Other installs wait until it finishes; this page checks every few seconds.`} /> : null}
    </SettingsSection>
    {data ? <>
      <SettingsSection title="Paseo">
        <ItemRow item={data.paseo} colors={colors} installer={installer} hostLabel={host.label} />
      </SettingsSection>
      <SettingsSection title="Development Flow kit" info="The skills, dev-flow.mjs and the docs they read, from each project profile's kitRoot. A developer checkout is updated with Git, so there's no install here.">
        {!data.kit.profiles.length ? <SettingsRow label="No project profiles" hint={`Looked in ${data.vault.root}\\Projects.`} /> : null}
        {data.kit.profiles.map(profile => <SettingsRow key={profile.file} label={profile.kitRoot ?? "No kitRoot"} hint={[profile.projectId && `Project ${profile.projectId}`, profile.detail, profile.file].filter(Boolean).join(" · ")}>
          <Status status={profile.status} colors={colors}>{profile.developerCheckout ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Developer checkout</Text> : null}</Status>
        </SettingsRow>)}
        {data.kit.rootNote ? <SettingsRow label="Skill links and rule files" hint={data.kit.rootNote} /> : null}
        {data.kit.stable ? <StableKitRow stable={data.kit.stable} colors={colors} installer={installer} hostLabel={host.label} /> : null}
      </SettingsSection>
      <SettingsSection title="Vault">
        <SettingsRow label={data.vault.root} hint={data.vault.exists ? "Task, run and decision records." : "Create it from Mission Control's Docs page."}>
          <Status status={data.vault.exists ? "installed" : "missing"} colors={colors} />
        </SettingsRow>
        <SettingsRow label="host.json" hint={data.vault.hostJson.detail}><Status status={data.vault.hostJson.status} colors={colors} /></SettingsRow>
      </SettingsSection>
      <SettingsSection title="Skills by provider" info="Each skill is a junction from the provider's skills folder to the kit, recorded in .mission-control-managed.json in that folder. A folder or link Mission Control didn't make is never replaced. Start a new agent session to pick up new skills.">
        {data.skills.map(group => <SkillGroupRows key={`${group.provider}-${group.group}`} group={group} colors={colors} installer={installer} hostLabel={host.label} />)}
      </SettingsSection>
      <SettingsSection title="Tools">
        {data.tools.filter(item => item.id !== "ocr-rules").map(item => <ItemRow key={item.id} item={item} colors={colors} installer={installer} hostLabel={host.label}
          action={item.id === "ocr" ? { kind: "ocr-cli" } : undefined} />)}
        {data.hiddenTools.length ? <SettingsRow label={`Not shown: ${data.hiddenTools.map(tool => tool.name).join(", ")}`}
          hint={`${data.hiddenTools.map(tool => tool.reason).join(" ")} Settings → Delivery shows each project's forge, where you can map a custom host or set a project's forge.`} /> : null}
      </SettingsSection>
      <SettingsSection title="OCR rule files" info="Copied from the kit's docs/ocr-kit only when missing, or when unchanged since Mission Control last wrote them (by SHA-256). An edited file shows as Modified and is left alone, and an existing rule.json is never merged.">
        {rules ? <ItemRow item={rules} colors={colors} installer={installer} hostLabel={host.label} action={{ kind: "ocr-rules" }} /> : null}
        {data.ocrRules.files.map(file => <SettingsRow key={file.path} label={file.path} hint={[`From ${file.source}`, file.note].filter(Boolean).join(" · ")}>
          <Status status={file.status} colors={colors} />
        </SettingsRow>)}
      </SettingsSection>
      <SettingsSection title="Provider CLIs" info="Installed and updated outside Mission Control, in Paseo's provider settings. Versions come from npm's global packages.">
        {data.providers.map(item => <ItemRow key={item.id} item={item} colors={colors} installer={installer} hostLabel={host.label} />)}
      </SettingsSection>
      <SettingsSection title="Recent installs" info="The last installs on this host, newest first. Command output is kept with key-like strings hidden.">
        {!data.log.length ? <SettingsRow label="None yet" /> : null}
        {data.log.map(entry => <SettingsRow key={`${entry.at}-${entry.action}`} label={`${entry.action} · ${formatDateTime(entry.at)}`}
          hint={[entry.summary, ...entry.changes].join(" · ")} error={entry.ok ? null : "Didn't finish"} />)}
      </SettingsSection>
    </> : null}
  </>;
}
