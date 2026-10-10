import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Text, View } from "react-native";
import {
  applyMcpToggle,
  planMcpToggle,
  readToolsInventory,
  type McpServerEntry,
  type McpTogglePlan,
  type McpToggleResult,
  type McpToggleTarget,
  type ToolProviderId,
  type ToolProviderInventory,
  type ToolSearchVerdict,
} from "../shared/tools-inventory";
import { formatDateTime } from "./date-time";
import { isSwitchable, switchAnchor } from "./server-switch";
import { MarkdownPreview } from "./markdown-preview";
import { CompactLink } from "./compact-link";

type Colors = PluginSurfaceProps["theme"]["colors"];

const VERDICTS: Record<ToolSearchVerdict["verdict"], string> = { on: "On", off: "Off", "not-supported": "Not supported", unknown: "Unknown" };
const SIGN_IN: Record<McpServerEntry["signIn"], string | null> = { "signed-in": "signed in", "needs-sign-in": "needs sign-in", "not-needed": null, unknown: "sign-in unknown" };
const TRANSPORTS: Record<McpServerEntry["transport"], string> = { stdio: "stdio", http: "HTTP", sse: "SSE", unknown: "unknown transport" };

function healthColor(state: McpServerEntry["health"]["state"], colors: Colors) {
  return state === "ok" ? colors.statusSuccess : state === "warning" ? colors.statusWarning : state === "error" ? colors.statusDanger : colors.foregroundMuted;
}

function serverHint(server: McpServerEntry) {
  const enabled = server.enabled === false ? "off" : server.enabled === true ? "on" : null;
  return [
    TRANSPORTS[server.transport],
    server.command ? `runs ${server.command}` : server.url,
    enabled && `${enabled}${server.enabledNote ? ` (${server.enabledNote.replace(/\.$/, "")})` : ""}`,
    !enabled && server.enabledNote,
    SIGN_IN[server.signIn],
    `from ${server.source}`,
    ...server.notes,
  ].filter(Boolean).join(" · ");
}

/** Skill names that appear in more than one folder, mapped to those folders' paths. */
function duplicateSkills(providers: ToolProviderInventory[]) {
  const folders = new Map<string, Set<string>>();
  for (const provider of providers) for (const folder of provider.skillFolders) for (const skill of folder.skills) {
    const key = skill.name.toLowerCase();
    if (!folders.has(key)) folders.set(key, new Set());
    folders.get(key)!.add(folder.path);
  }
  return folders;
}

function Preview({ content, truncated, colors }: { content: string; truncated: boolean; colors: Colors }) {
  return <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
    <MarkdownPreview content={content} colors={colors} />
    {truncated ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Only the first 64 KB is shown.</Text> : null}
  </View>;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : error ? String(error) : null;
const NEW_SESSIONS = "Changes apply to new agent sessions; running agents keep the servers they started with.";

function verb(target: McpToggleTarget) {
  return target.enabled === false ? "Turn off" : target.enabled === true ? "Turn on" : "Undo";
}
const DONE = { "Turn off": "Turned off", "Turn on": "Turned on", Undo: "Undone" } as const;
/** "on" or "off" from a plan's value, such as "false (off)" or "not listed (on)". */
const state = (value: string) => value.endsWith("(off)") ? "off" : "on";

/** Turning a server on or off: plan, confirm, apply, then offer Undo. The inventory is re-read after each attempt. */
function useServerSwitch(onChanged: () => void) {
  const plan = useRpc(planMcpToggle);
  const apply = useRpc(applyMcpToggle);
  const [requested, setRequested] = useState<McpToggleTarget | null>(null);
  const [pending, setPending] = useState<McpTogglePlan | null>(null);
  // The last applied change stays, with its Undo, until another change succeeds; a failed or cancelled Undo keeps it.
  const [done, setDone] = useState<McpToggleResult | null>(null);
  const planning = useMutation({ mutationFn: (target: McpToggleTarget) => plan(target), onSuccess: setPending });
  const applying = useMutation({
    mutationFn: (confirmed: McpTogglePlan) => apply({ ...confirmed.target, fingerprint: confirmed.fingerprint }),
    onSuccess: result => { setPending(null); setDone(result); },
    onError: () => setPending(null),
    onSettled: onChanged,
  });
  const reset = () => { planning.reset(); applying.reset(); };
  return {
    pending, done, busy: planning.isPending || applying.isPending,
    error: errorText(planning.error) ?? errorText(applying.error),
    /** The last change asked for; any error shows under its server's row. */
    requested,
    request(target: McpToggleTarget) { reset(); setPending(null); setRequested(target); planning.mutate(target); },
    confirm() { if (pending) applying.mutate(pending); },
    cancel() { reset(); setPending(null); },
    dismiss() { reset(); setDone(null); },
  };
}
type ServerSwitch = ReturnType<typeof useServerSwitch>;

/** The anchors of a change's error, confirmation and result in one provider's server list (see switchAnchor). */
function switchAnchors(provider: ToolProviderInventory, switcher: ServerSwitch) {
  return {
    error: switcher.error ? switchAnchor(provider.id, provider.servers, switcher.requested) : null,
    plan: switchAnchor(provider.id, provider.servers, switcher.pending?.target),
    // While a confirmation is open, the last result waits, so only one change is on screen.
    done: switcher.pending ? null : switchAnchor(provider.id, provider.servers, switcher.done?.target),
  };
}

/** The rows anchored at `at`: under the server row with that index, or -1 for the top of the section. */
function SwitchRows({ at, anchors, switcher }: { at: number; anchors: ReturnType<typeof switchAnchors>; switcher: ServerSwitch }) {
  const { pending, done } = switcher;
  const rows = [];
  if (switcher.error && anchors.error === at) rows.push(<SettingsRow key="error" label="The server wasn't changed" error={switcher.error} />);
  if (pending && anchors.plan === at) {
    const action = verb(pending.target);
    const change = `${pending.file} · ${pending.key}: ${pending.before} → ${pending.after}`;
    if (pending.unchanged) {
      rows.push(<SettingsAction key="unchanged" label={`${pending.target.server} is already ${state(pending.after)}`} hint={`${change}. Nothing to change.`} actionLabel="OK" onPress={switcher.cancel} />);
    } else {
      rows.push(<SettingsRow key="plan" label={`${action} ${pending.target.server}?`}
        hint={`File: ${pending.file} · Server: ${pending.target.server} · Key: ${pending.key} · ${pending.before} → ${pending.after}. Only this key changes. The file is backed up to Mission Control's folder first and re-read just before writing; if it changed since now, nothing is written. ${NEW_SESSIONS}`} />);
      rows.push(<SettingsAction key="confirm" label="Make this change" actionLabel={switcher.busy ? "Saving…" : action} disabled={switcher.busy} onPress={switcher.confirm} />);
      rows.push(<SettingsAction key="cancel" label="Leave the file as it is" actionLabel="Cancel" disabled={switcher.busy} onPress={switcher.cancel} />);
    }
  }
  if (done && anchors.done === at) {
    const hint = [`${done.file} · ${done.key}: ${done.before} → ${done.after}`, done.backup && `Backup: ${done.backup}`, ...done.checks, done.changed && NEW_SESSIONS].filter(Boolean).join(" · ");
    rows.push(<SettingsAction key="done" label={done.changed ? `${DONE[verb(done.target)]}: ${done.target.server}` : `${done.target.server} was already ${state(done.after)}`}
      hint={hint} actionLabel={done.changed ? "Undo" : "OK"} disabled={switcher.busy}
      onPress={() => done.changed ? switcher.request(done.undo) : switcher.dismiss()} />);
  }
  return <>{rows}</>;
}

function ServerRow({ provider, server, switcher, colors }: { provider: ToolProviderInventory; server: McpServerEntry; switcher: ServerSwitch; colors: Colors }) {
  const toggle = server.toggle;
  if (toggle && isSwitchable(provider.id, server)) {
    const enabled = toggle.enabled;
    return <SettingsAction label={server.name} hint={`${serverHint(server)} · ${server.health.label}`} actionLabel={enabled ? "Turn off" : "Turn on"} disabled={switcher.busy}
      onPress={() => switcher.request({ provider: provider.id as McpToggleTarget["provider"], server: server.name, enabled: !enabled })} />;
  }
  const hint = [serverHint(server), toggle?.readOnly && `Read-only here: ${toggle.readOnly}`].filter(Boolean).join(" · ");
  return <SettingsRow label={server.name} hint={hint}>
    <Text style={{ color: healthColor(server.health.state, colors), maxWidth: 220, textAlign: "right" }}>{server.health.label}</Text>
  </SettingsRow>;
}

function ProviderDetails({ provider, duplicates, switcher, colors }: { provider: ToolProviderInventory; duplicates: Map<string, Set<string>>; switcher: ServerSwitch; colors: Colors }) {
  const [openRules, setOpenRules] = useState<Record<string, boolean>>({});
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const search = provider.toolSearch;
  const switchable = provider.servers.some(server => isSwitchable(provider.id, server));
  const anchors = switchAnchors(provider, switcher);
  return <>
    <SettingsSection title={`${provider.name} · MCP servers`} info={`Global servers only; servers set up for one repository aren't shown. Stdio servers are never started: the check only looks for their command. Remote servers get one request without your credentials. ${provider.notes.join(" ")}`}>
      {provider.errors.map(error => <SettingsRow key={error} label="Couldn't read part of the setup" error={error} />)}
      {provider.id === "claude"
        ? <SettingsRow label="Read-only" hint="Claude Code has no global off switch for these servers (/mcp turns one off per project only), and tool search already loads their tools only when an agent needs them, so Mission Control leaves them as they are." />
        : switchable ? <SettingsRow label="Turning servers on and off" hint={`Each change shows the file and key first, is backed up, and can be undone. Nothing else here changes a config. ${NEW_SESSIONS}`} /> : null}
      <SwitchRows at={-1} anchors={anchors} switcher={switcher} />
      {!provider.servers.length ? <SettingsRow label="No global MCP servers" hint={`Looked in ${provider.configPath}.`} /> : null}
      {provider.servers.map((server, index) => <Fragment key={`${server.source}-${server.name}`}>
        <ServerRow provider={provider} server={server} switcher={switcher} colors={colors} />
        <SwitchRows at={index} anchors={anchors} switcher={switcher} />
      </Fragment>)}
    </SettingsSection>
    <SettingsSection title="Tool search" info="Tool search loads MCP tools only when an agent needs them, which keeps them out of every agent's context.">
      <SettingsRow label={VERDICTS[search.verdict]} hint={search.reason}>
        <Text style={{ color: search.verdict === "on" ? colors.statusSuccess : search.verdict === "unknown" ? colors.foregroundMuted : colors.statusWarning }}>{VERDICTS[search.verdict]}</Text>
      </SettingsRow>
      <SettingsRow label={search.verdict === "on" ? "Settings" : "How to turn it on"} hint={search.howToEnable} />
    </SettingsSection>
    <SettingsSection title="Rule files" info="Global instructions this provider adds to every session. Read-only; edit the files themselves to change them.">
      {provider.rules.map(rule => {
        const key = `${rule.label}-${rule.path}`;
        const status = rule.state === "missing" ? "Not present" : rule.state === "inactive" ? "Present, not read" : `Read${rule.size !== null ? ` · ${rule.size.toLocaleString()} bytes` : ""}`;
        const hint = [rule.path, status, rule.note].filter(Boolean).join(" · ");
        if (rule.preview === null) return <SettingsRow key={key} label={rule.label} hint={hint} />;
        const open = !!openRules[key];
        return <View key={key}>
          <SettingsAction label={rule.label} hint={hint} actionLabel={open ? "Hide" : "Preview"} onPress={() => setOpenRules(state => ({ ...state, [key]: !open }))} />
          {open ? <Preview content={rule.preview} truncated={rule.truncated} colors={colors} /> : null}
        </View>;
      })}
    </SettingsSection>
    <SettingsSection title="Skills" info="Global skill folders this provider reads, with each skill's name and description. A skill in several folders is marked.">
      {provider.skillFolders.map(folder => {
        const key = folder.path;
        const open = !!openFolders[key];
        const hint = [folder.path, folder.note].filter(Boolean).join(" · ");
        if (!folder.exists || !folder.skills.length) return <SettingsRow key={key} label={folder.label} hint={hint}>
          <Text style={{ color: colors.foregroundMuted }}>{folder.exists ? "No skills" : "Not present"}</Text>
        </SettingsRow>;
        return <View key={key}>
          <SettingsAction label={`${folder.label} · ${folder.skills.length} skill${folder.skills.length === 1 ? "" : "s"}`} hint={hint}
            actionLabel={open ? "Hide" : "Show"} onPress={() => setOpenFolders(state => ({ ...state, [key]: !open }))} />
          {open ? folder.skills.map(skill => {
            const others = [...(duplicates.get(skill.name.toLowerCase()) ?? [])].filter(path => path !== folder.path);
            const description = skill.description.length > 280 ? `${skill.description.slice(0, 279)}…` : skill.description;
            const hint = [description || "No description", !skill.enabled && "Turned off in the config", others.length && `Also in ${others.join(", ")}`].filter(Boolean).join(" · ");
            return <SettingsRow key={skill.path} label={skill.name} hint={hint} />;
          }) : null}
        </View>;
      })}
    </SettingsSection>
  </>;
}

/**
 * Settings → Plugins → Mission Control → Tools & skills: each agent's global MCP servers, rules and skills.
 * The one change it makes is turning a Codex, OpenCode or Copilot CLI server on or off, after confirmation.
 */
export function ToolsSettings({ host, theme }: PluginSurfaceProps) {
  const read = useRpc(readToolsInventory);
  const inventory = useQuery({
    queryKey: ["mission-control", "tools-inventory", host.id], queryFn: () => read({}),
    retry: false, refetchOnWindowFocus: false, staleTime: 60_000,
  });
  const switcher = useServerSwitch(() => void inventory.refetch());
  const [selected, setSelected] = useState<ToolProviderId>("claude");
  const colors = theme.colors;
  const data = inventory.data;
  const provider = data?.providers.find(entry => entry.id === selected) ?? null;
  const error = inventory.error instanceof Error ? inventory.error.message : inventory.error ? String(inventory.error) : null;

  return <>
    <SettingsSection title="Tools & skills" info={`What Claude Code, Codex, OpenCode and Copilot CLI load globally on ${host.label}. The only change it makes is turning a Codex, OpenCode or Copilot CLI MCP server on or off, after you confirm; it never starts a server or signs in. ${NEW_SESSIONS} Secrets such as tokens, headers, environment values and command arguments are never shown.`}>
      <SettingsRow label={inventory.isFetching ? "Reading this host's setup…" : data ? `Checked ${formatDateTime(data.checkedAt)}` : "Not read yet"}
        hint={`Reads the global config files, rule files and skill folders on ${host.label}.`} error={error}>
        <CompactLink iconOnly icon="RefreshCw" label="Refresh tools and skills" colors={colors} disabled={inventory.isFetching} onPress={() => void inventory.refetch()} />
      </SettingsRow>
      {data?.providers.map(entry => {
        const rules = entry.rules.filter(rule => rule.state === "active").length;
        const skills = entry.skillFolders.reduce((total, folder) => total + folder.skills.length, 0);
        const summary = entry.found
          ? `${entry.servers.length} MCP server${entry.servers.length === 1 ? "" : "s"} · ${rules} rule file${rules === 1 ? "" : "s"} · ${skills} skill${skills === 1 ? "" : "s"} · tool search ${VERDICTS[entry.toolSearch.verdict].toLowerCase()}`
          : "No global setup found";
        return <SettingsRow key={entry.id} label={entry.name} hint={summary} error={entry.errors.length ? `${entry.errors.length} file${entry.errors.length === 1 ? "" : "s"} couldn't be read.` : null} />;
      })}
    </SettingsSection>
    {data ? <SettingsSection title="Provider">
      <SettingsSelect<ToolProviderId> label="Show details for" value={selected} onValueChange={setSelected}
        options={data.providers.map(entry => ({ label: entry.name, value: entry.id }))} />
    </SettingsSection> : null}
    {provider && data ? <ProviderDetails key={provider.id} provider={provider} duplicates={duplicateSkills(data.providers)} switcher={switcher} colors={colors} /> : null}
  </>;
}
