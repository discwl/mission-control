import { CompactLink } from "./compact-link";
import { getPaseoClient, type PluginHostSummary, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { AppModal as Modal } from "./app-modal";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { renameAgent } from "../shared/agent-names";
import { listTasks } from "../shared/tasks";
import { nameWarnings, renameConflict } from "../shared/naming";
import { DELIVERY_TEXT_ROLE } from "../shared/paseo-metadata";
import { flattenAgentTree, groupAgents } from "../shared/subagents";
import { contextAgents, NAMER_ROLE, readUserMessages, resolveNamingModel, suggestNames, SUGGESTION_BATCH, type WorkspaceContext } from "./name-suggestions";

type Colors = PluginSurfaceProps["theme"]["colors"];
// Mission Control's own short-lived model agents (name suggestions, commit and pull request text) are never named or read.
const isHelper = (agent: { role?: string | null }) => agent.role === NAMER_ROLE || agent.role === DELIVERY_TEXT_ROLE;
type Paseo = ReturnType<typeof getPaseoClient>;
// context: the "Sub-agent of …" line for an agent another agent started.
type NamedAgent = { id: string; name: string; role?: string | null; updatedAt?: string; context?: string | null; parentAgentId?: string | null };
export type NamingWorkspace = { id: string; name: string; projectName: string; agents: NamedAgent[] };
type Kind = "workspace" | "agent";
// nested: a sub-agent listed right under its parent.
type Row = { kind: Kind; id: string; workspaceId: string; header: string; context: string | null; nested?: boolean; reviewed: string; draft: string; selected: boolean; reason: string | null; error: string | null };
type Undo = { kind: Kind; id: string; previous: string; applied: string };
type Group = { workspace: NamingWorkspace; suggestWorkspace: boolean; agentIds: Set<string> };

/** A workspace's agents with each sub-agent right after its parent; nested marks those. */
function agentsInTreeOrder(agents: readonly NamedAgent[]): { agent: NamedAgent; nested: boolean }[] {
  return groupAgents(agents.map(agent => ({ ...agent, parentAgentId: agent.parentAgentId ?? null }))).flatMap(node => flattenAgentTree(node));
}

async function currentWorkspaceName(paseo: Paseo, workspaceId: string): Promise<string> {
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace) throw new Error("This workspace is no longer available.");
  return workspace.title || workspace.name;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isChanged(row: Row): boolean {
  return Boolean(row.draft.trim()) && row.draft.trim() !== row.reviewed;
}

/** Suggestion targets grouped by workspace, then batched so one naming agent answers about eight names. */
function batchTargets(targets: Row[], workspaces: NamingWorkspace[]): Group[][] {
  const groups = new Map<string, Group>();
  for (const row of targets) {
    const workspace = workspaces.find(candidate => candidate.id === row.workspaceId);
    if (!workspace) continue;
    const group = groups.get(workspace.id) ?? { workspace, suggestWorkspace: false, agentIds: new Set<string>() };
    if (row.kind === "workspace") group.suggestWorkspace = true;
    else group.agentIds.add(row.id);
    groups.set(workspace.id, group);
  }
  const batches: Group[][] = [];
  let size = SUGGESTION_BATCH;
  for (const group of groups.values()) {
    if (size >= SUGGESTION_BATCH) { batches.push([]); size = 0; }
    batches[batches.length - 1].push(group);
    size += (group.suggestWorkspace ? 1 : 0) + group.agentIds.size;
  }
  return batches;
}

/** Current → Suggested rows. Suggestions only fill the fields; nothing is renamed until Apply selected. */
function NamesDialog({ buttonLabel, buttonHint, title, host, taskHostId, workspaces, includeAgents, includeWorkspaces = true, iconOnly = true, rowAction = false, disabled = false, colors, extra }: {
  buttonLabel: string; buttonHint: string; title: string; host: PluginHostSummary; taskHostId: string; workspaces: NamingWorkspace[]; includeAgents: boolean; colors: Colors;
  includeWorkspaces?: boolean; iconOnly?: boolean; rowAction?: boolean; disabled?: boolean;
  extra?: (close: () => void, busy: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<"suggest" | "apply" | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo[]>([]);
  const lock = useRef(false);
  // The workspaces and agents as they were when the dialog opened.
  const opened = useRef<NamingWorkspace[]>([]);
  // A new opening discards late results from an earlier run; stop ends a run after its current batch.
  const generation = useRef(0);
  const stop = useRef(false);
  const readTasks = useRpc(listTasks);
  const renameAgentOnHost = useRpc(renameAgent);
  const queryClient = useQueryClient();
  const toast = useToast();
  const online = host.status === "online";
  const toApply = rows.filter(row => row.selected && isChanged(row));
  const hasTargets = workspaces.some(workspace => includeWorkspaces || (includeAgents && workspace.agents.some(agent => !isHelper(agent))));

  function start() {
    if (disabled || !online || !hasTargets) return;
    generation.current += 1;
    opened.current = workspaces;
    // The names shown when the dialog opened; applying checks they are still current.
    setRows(workspaces.flatMap(workspace => [
      ...(includeWorkspaces ? [{ kind: "workspace" as const, id: workspace.id, workspaceId: workspace.id, header: includeAgents ? "Workspace" : workspace.projectName, context: null, reviewed: workspace.name, draft: workspace.name, selected: false, reason: null, error: null }] : []),
      ...(includeAgents ? agentsInTreeOrder(workspace.agents.filter(agent => !isHelper(agent))).map(({ agent, nested }) => (
        { kind: "agent" as const, id: agent.id, workspaceId: workspace.id, header: nested ? "Sub-agent" : "Agent", context: nested ? null : agent.context ?? null, nested, reviewed: agent.name, draft: agent.name, selected: false, reason: null, error: null })) : []),
    ]));
    setError(null);
    setProgress(lock.current ? "Finishing an earlier run…" : null);
    setOpen(true);
  }

  function close() {
    // Closing during suggestions stops after the current batch; renames always finish first.
    if (busy === "apply") return;
    stop.current = true;
    setOpen(false);
  }

  function updateRow(id: string, patch: Partial<Row>) {
    setRows(current => current.map(row => row.id === id ? { ...row, ...patch } : row));
  }

  async function run(kind: "suggest" | "apply", work: (paseo: Paseo) => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    stop.current = false;
    setBusy(kind);
    setError(null);
    try {
      await work(getPaseoClient(host.serverId));
    } catch (cause) {
      setError(message(cause));
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["mission-control", "roster", host.serverId] });
      lock.current = false;
      setBusy(null);
      setProgress(null);
    }
  }

  async function workspaceContext(paseo: Paseo, group: Group, reviewed: Map<string, string>): Promise<WorkspaceContext> {
    const { workspace } = group;
    // Mission Control tasks live in this installation's vault, so other hosts send none.
    const tasks = host.serverId === taskHostId
      ? await readTasks({ serverId: taskHostId, workspaceId: workspace.id }).then(result => result.tasks.map(task => ({ title: task.title, status: task.status, ticket: task.ticket ? { system: task.ticket.system, key: task.ticket.key } : null })), () => [])
      : [];
    const readers = contextAgents(workspace.agents.filter(agent => !isHelper(agent)), group.agentIds);
    const agents = await Promise.all(readers.map(async agent => ({
      id: agent.id, name: reviewed.get(agent.id) ?? agent.name, suggest: group.agentIds.has(agent.id),
      messages: await readUserMessages(paseo.agents.ref(agent.id).timeline).catch(() => []),
    })));
    return { id: workspace.id, currentName: reviewed.get(workspace.id) ?? workspace.name, projectName: workspace.projectName, suggest: group.suggestWorkspace, tasks, agents };
  }

  function suggest(targets: Row[]) {
    const runGeneration = generation.current;
    const current = () => runGeneration === generation.current;
    const reviewed = new Map(rows.map(row => [row.id, row.reviewed]));
    void run("suggest", async paseo => {
      const model = await resolveNamingModel(paseo);
      setModelLabel(model.label);
      const batches = batchTargets(targets, opened.current);
      for (const [index, batch] of batches.entries()) {
        if (stop.current) break;
        if (current()) setProgress(targets.length > 1 ? `Suggesting (batch ${index + 1} of ${batches.length})…` : "Reading the chat and suggesting a name…");
        const ids = batch.flatMap(group => [...(group.suggestWorkspace ? [group.workspace.id] : []), ...group.agentIds]);
        try {
          const contexts = await Promise.all(batch.map(group => workspaceContext(paseo, group, reviewed)));
          // The short-lived naming agent runs in the batch's first workspace and is archived afterwards.
          const suggestions = await suggestNames(paseo, batch[0].workspace.id, model, contexts);
          if (!current()) continue;
          for (const id of ids) {
            const suggestion = suggestions.get(id);
            updateRow(id, suggestion
              ? { draft: suggestion.name, reason: suggestion.reason || null, selected: suggestion.name !== reviewed.get(id), error: null }
              : { error: "No suggestion came back for this name." });
          }
        } catch (cause) {
          if (current()) for (const id of ids) updateRow(id, { error: message(cause) });
        }
      }
    });
  }

  // Both renames refuse to overwrite a name that changed after `expected` was shown.
  async function renameRow(paseo: Paseo, kind: Kind, id: string, expected: string, next: string): Promise<string> {
    if (kind === "agent") return (await renameAgentOnHost({ serverId: host.serverId, agentId: id, expected, name: next })).title;
    const conflict = renameConflict(expected, await currentWorkspaceName(paseo, id));
    if (conflict) throw new Error(conflict);
    const title = (await paseo.workspaces.ref(id).setTitle(next)).title ?? next;
    void queryClient.invalidateQueries({ queryKey: ["mission-control", "workspace", host.serverId, id] });
    return title;
  }

  function apply() {
    const targets = toApply;
    void run("apply", async paseo => {
      const applied: Undo[] = [];
      for (const row of targets) {
        try {
          const name = await renameRow(paseo, row.kind, row.id, row.reviewed, row.draft.trim());
          applied.push({ kind: row.kind, id: row.id, previous: row.reviewed, applied: name });
          updateRow(row.id, { reviewed: name, draft: name, selected: false, reason: null, error: null });
        } catch (cause) {
          updateRow(row.id, { error: message(cause) });
        }
      }
      if (applied.length) {
        setUndo(applied);
        toast.show(applied.length === 1 ? "Renamed" : `${applied.length} names changed`, { variant: "success" });
      }
    });
  }

  function revert() {
    const targets = undo;
    void run("apply", async paseo => {
      const failed: Undo[] = [];
      for (const target of targets) {
        try {
          const restored = await renameRow(paseo, target.kind, target.id, target.applied, target.previous);
          updateRow(target.id, { reviewed: restored, draft: restored, selected: false, error: null });
        } catch (cause) {
          failed.push(target);
          updateRow(target.id, { error: `Undo failed: ${message(cause)}` });
        }
      }
      setUndo(failed);
      if (failed.length < targets.length) toast.show("Rename undone", { variant: "success" });
    });
  }

  const workspaceName = (id: string) => rows.find(row => row.kind === "workspace" && row.id === id)?.draft ?? opened.current.find(workspace => workspace.id === id)?.name ?? "";
  const inputStyle = { color: colors.foreground, borderColor: colors.border, borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, minHeight: 44, backgroundColor: colors.surface1 } as const;
  const linkButton = (label: string, hint: string, onPress: () => void, disabled: boolean) => (
    <CompactLink colors={colors} label={(label)} accessibilityRole="button" accessibilityLabel={hint} disabled={disabled} onPress={onPress} />
  );

  return <>
    {rowAction ? <Pressable accessibilityRole="button" accessibilityLabel={buttonHint} accessibilityState={{ disabled: disabled || !online || !hasTargets }} disabled={disabled || !online || !hasTargets} onPress={start} hitSlop={4}
      style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 7, opacity: disabled || !online || !hasTargets ? 0.4 : 1 }}>
      <Icon name="Pencil" size={15} color={colors.foregroundMuted} />
    </Pressable> : <CompactLink iconOnly={iconOnly} icon="Pencil" label={buttonLabel} accessibilityLabel={buttonHint} disabled={disabled || !online || !hasTargets} onPress={start} colors={colors} />}
    <Modal colors={colors} title={title} open={open} onOpenChange={next => { if (!next) close(); }}>
      <Modal.Content>
        <View style={{ gap: 12 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Host: {host.label}. Use 2–5 words: the overall goal for a workspace, the job for an agent. Prefix ticket-related workspace titles with the Jira key or Azure DevOps work-item number. Keep status such as Review or Blocked in labels. Suggest sends a small model{modelLabel ? ` (${modelLabel})` : " (Haiku, or GPT-6-Luna on low)"} the current names, linked task titles and ticket numbers, and each agent's first and latest user prompts. It runs as a short-lived agent in the workspace, so its provider may also load that project's instructions. Nothing is renamed until you apply.</Text>
          {rows.length > 1 || busy === "suggest" ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            {rows.length > 1 ? linkButton(`Suggest all (${rows.length})`, "Suggest all names", () => suggest(rows), Boolean(busy) || !online) : null}
            {busy === "suggest" ? linkButton("Stop", "Stop suggesting after the current batch", () => { stop.current = true; setProgress("Stopping after the current batch…"); }, false) : null}
            {progress ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{progress}</Text> : null}
          </View> : null}
          {rows.map((row, index) => {
            const warnings = nameWarnings(row.draft, row.kind === "agent" ? workspaceName(row.workspaceId) : undefined);
            return <View key={row.id} style={{ gap: 6, borderTopWidth: index ? 1 : 0, borderTopColor: colors.border, paddingTop: index ? 10 : 0, marginLeft: row.nested ? 20 : 0 }}>
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 9 }}>
                <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: row.selected }} accessibilityLabel={`Rename ${row.reviewed}`} disabled={Boolean(busy)} onPress={() => updateRow(row.id, { selected: !row.selected })}
                  style={{ minHeight: 44, minWidth: 28, paddingTop: 2 }}>
                  <View style={{ width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: row.selected ? colors.accent : colors.border, backgroundColor: row.selected ? colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
                    {row.selected ? <Text style={{ color: colors.accentForeground, fontSize: 12, lineHeight: 14 }}>✓</Text> : null}
                  </View>
                </Pressable>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={{ color: colors.foreground, fontWeight: "600" }}>{row.nested ? "↳ " : ""}{row.header}</Text>
                  {row.context ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>↳ {row.context}</Text> : null}
                  <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Current: {row.reviewed}</Text>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Suggested</Text>
                  <TextInput accessibilityLabel={`New name for ${row.reviewed}`} value={row.draft} editable={!busy}
                    onChangeText={text => updateRow(row.id, { draft: text, selected: Boolean(text.trim()) && text.trim() !== row.reviewed })} style={inputStyle} />
                  {row.reason ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Why: {row.reason}</Text> : null}
                  {warnings.map(warning => <Text key={warning} style={{ color: colors.statusWarning, fontSize: 12 }}>{warning}</Text>)}
                  {row.error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{row.error}</Text> : null}
                </View>
                {linkButton("Suggest", `Suggest a name for ${row.reviewed}`, () => suggest([row]), Boolean(busy) || !online)}
              </View>
            </View>;
          })}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 10 }}>
            {undo.length ? <CompactLink colors={colors} label={(undo.length === 1 ? `Undo (restore “${undo[0].previous}”)` : `Undo ${undo.length} renames`)} accessibilityRole="button" accessibilityLabel={undo.length === 1 ? `Undo rename to ${undo[0].previous}` : `Undo ${undo.length} renames`} disabled={Boolean(busy) || !online} onPress={revert} /> : null}
            <Pressable accessibilityRole="button" accessibilityLabel="Apply selected names" disabled={Boolean(busy) || !online || !toApply.length} onPress={apply}
              style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: "center", borderRadius: 7, backgroundColor: toApply.length ? colors.accent : colors.surface2 }}>
              <Text style={{ color: toApply.length ? colors.accentForeground : colors.foregroundMuted, fontWeight: "600" }}>{busy === "apply" ? "Working…" : `Apply selected${toApply.length > 1 ? ` (${toApply.length})` : ""}`}</Text>
            </Pressable>
          </View>
          {extra?.(close, Boolean(busy))}
          {!online ? <Text style={{ color: colors.statusWarning }}>Reconnect this host to rename.</Text> : null}
          {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{error}</Text> : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
            <Pressable accessibilityRole="button" disabled={busy === "apply"} onPress={close} style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: "center" }}><Text style={{ color: colors.foreground }}>Done</Text></Pressable>
          </View>
        </View>
      </Modal.Content>
    </Modal>
  </>;
}

export function ReviewNames({ host, taskHostId, workspace, agents, colors, canNavigate, openAgent }: {
  host: PluginHostSummary; taskHostId: string; workspace: { id: string; name: string; projectName: string }; agents: NamedAgent[]; colors: Colors; canNavigate: boolean; openAgent: (id: string) => void;
}) {
  // Agents are renamed by this installation's server, which reaches only its own host's daemon.
  const agentsRenamable = host.serverId === taskHostId;
  return <NamesDialog buttonLabel="Review names" buttonHint={`Review names in ${workspace.name}`} title="Review names" host={host} taskHostId={taskHostId}
    workspaces={[{ id: workspace.id, name: workspace.name, projectName: workspace.projectName, agents }]} includeAgents={agentsRenamable} colors={colors}
    extra={agentsRenamable ? undefined : (close, busy) => <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10, gap: 6 }}>
      <Text style={{ color: colors.foreground, fontWeight: "600" }}>Agents ({agents.length})</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Mission Control can rename agents only on the host it runs on. Open Mission Control on {host.label}, or rename them from their tab.</Text>
      {agentsInTreeOrder(agents).map(({ agent, nested }) => {
        const agentWarnings = nameWarnings(agent.name, workspace.name);
        return <View key={agent.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginLeft: nested ? 20 : 0 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: 13 }}>{nested ? "↳ " : ""}{agent.name}</Text>
            {!nested && agent.context ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>↳ {agent.context}</Text> : null}
            {agentWarnings.map(warning => <Text key={warning} style={{ color: colors.statusWarning, fontSize: 11 }}>{warning}</Text>)}
          </View>
          <CompactLink colors={colors} label={"Open →"} accessibilityRole="button" accessibilityLabel={`Open ${agent.name} to rename it`} disabled={!canNavigate || busy} onPress={() => { close(); openAgent(agent.id); }} />
        </View>;
      })}
    </View>} />;
}

/** The header edits the workspace and agents; row pencils edit only their selected agent. */
export function RenameAgents({ host, taskHostId, workspace, agents, colors, agentId, disabled = false }: {
  host: PluginHostSummary; taskHostId: string; workspace: { id: string; name: string; projectName: string };
  agents: NamedAgent[]; colors: Colors; agentId?: string; disabled?: boolean;
}) {
  const targets = agents.filter(agent => !isHelper(agent) && (agentId === undefined || agent.id === agentId));
  if (agentId !== undefined && targets.length === 0) return null;
  const label = agentId === undefined ? `Rename workspace and agents in ${workspace.name}` : `Rename ${targets[0].name}`;
  return <NamesDialog buttonLabel={label} buttonHint={label} title={agentId === undefined ? `Rename workspace and agents · ${workspace.name}` : "Rename agent"}
    host={host} taskHostId={taskHostId} workspaces={[{ ...workspace, agents: targets }]} includeAgents includeWorkspaces={agentId === undefined} iconOnly rowAction={agentId !== undefined}
    disabled={disabled || host.serverId !== taskHostId} colors={colors} />;
}

/** Bulk suggestions for every workspace in the current list. Agents are renamed from each workspace's Review names. */
export function RenameAll({ host, taskHostId, workspaces, colors }: { host: PluginHostSummary; taskHostId: string; workspaces: NamingWorkspace[]; colors: Colors }) {
  return <NamesDialog buttonLabel={`Rename all (${workspaces.length})`} buttonHint={`Suggest names for ${workspaces.length} workspaces on ${host.label}`} title={`Rename workspaces · ${host.label}`}
    host={host} taskHostId={taskHostId} workspaces={workspaces} includeAgents={false} colors={colors} />;
}
