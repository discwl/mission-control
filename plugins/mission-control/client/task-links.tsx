import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { setHandledUnder } from "../shared/tasks";
import { CompactLink } from "./compact-link";
import type { MissionControlCopy } from "./host-bridge";
import type { KanbanTask } from "./kanban-model";

type LinkProps = { item: KanbanTask; tasks: KanbanTask[]; openTask(key: string): void; colors: PluginSurfaceProps["theme"]["colors"] };

function name(item: KanbanTask) {
  return item.row.entry.task.ticket?.key || item.row.entry.task.title;
}

export function PrimaryTaskLink({ primary, taskId, openTask, colors }: Pick<LinkProps, "openTask" | "colors"> & { primary?: KanbanTask; taskId: string }) {
  if (!primary) return <Text selectable style={{ color: colors.foregroundMuted }}>Linked primary task {taskId} is unavailable in this host snapshot.</Text>;
  return <CompactLink colors={colors} icon="ArrowRight" label={`Handled under ${name(primary)}`} onPress={() => openTask(primary.row.key)} />;
}

export function TaskLinkEditor({ item, tasks, openTask, colors, copy, available, workspaceId, refresh, onSaved }: LinkProps & {
  onSaved(task: KanbanTask["row"]["entry"]["task"]): void; copy?: MissionControlCopy; available: boolean; workspaceId?: string | null; refresh(): void;
}) {
  const { row } = item, task = row.entry.task;
  const [expanded, setExpanded] = useState(false);
  const [expectedVersion, setExpectedVersion] = useState(task.updatedAt);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const children = tasks.filter(({ row: other }) => other.serverId === row.serverId && other.entry.task.handledUnder?.serverId === row.serverId && other.entry.task.handledUnder.taskId === task.taskId);
  const supported = copy?.serverId === row.serverId && copy.supports(setHandledUnder.name);
  const eligible = (other: KanbanTask) => other.row.serverId === row.serverId && other.row.entry.task.taskId !== task.taskId && !other.row.entry.task.handledUnder && !other.row.limited && other.row.state !== "Unconfirmed" && !other.row.entry.problem;
  const needle = search.trim().toLowerCase();
  const choices = expanded && !children.length ? tasks.filter(other => eligible(other) && [name(other), other.row.entry.task.title, other.row.entry.task.taskId].some(field => field.toLowerCase().includes(needle))) : [];
  const target = selection ? tasks.find(other => eligible(other) && other.row.entry.task.taskId === selection) : undefined;
  const current = task.handledUnder?.taskId ?? null;
  const dirty = selection !== current && (!selection || !!target);
  const canEdit = available && supported && !!workspaceId && !children.length;
  const changed = expectedVersion !== task.updatedAt;
  function begin() {
    setSelection(current); setExpectedVersion(task.updatedAt); setSearch(""); setMessage(""); setExpanded(true);
  }
  async function save() {
    if (!copy || !workspaceId || !canEdit || !dirty || busy || changed) return;
    setBusy(true); setMessage("");
    try {
      const result = await copy.rpc(setHandledUnder.name, { serverId: row.serverId, workspaceId, taskId: task.taskId, expectedUpdatedAt: expectedVersion, targetTaskId: selection });
      const saved = setHandledUnder.output.parse(result).task;
      if (saved.taskId !== task.taskId || (saved.handledUnder?.taskId ?? null) !== selection || (saved.handledUnder && saved.handledUnder.serverId !== row.serverId)) throw new Error("The host returned a different task link. Refresh to verify the saved record.");
      onSaved(saved); setExpanded(false); setMessage(selection ? "Task link saved." : "Task link removed.");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); refresh(); }
  }
  const caption = children.length ? `Tickets handled here · ${children.length}` : task.handledUnder ? "Edit task link" : "Link to a primary task";
  return <View style={{ gap: 8, maxWidth: 950 }}>
    <CompactLink label={caption} colors={colors} expanded={expanded} disabled={busy} onPress={() => expanded ? setExpanded(false) : begin()} />
    {expanded && children.length ? children.map(child => <CompactLink key={child.row.key} label={`Open ${name(child)}`} colors={colors} onPress={() => openTask(child.row.key)} />) : null}
    {expanded && !children.length ? !canEdit ? <Text style={{ color: colors.foregroundMuted }}>{available && copy && !supported ? `Update Mission Control on ${row.hostLabel} to edit task links.` : `A fresh task record and assigned workspace on ${row.hostLabel} are required to edit this link.`}</Text> : <>
      <Text style={{ color: colors.foreground }}>Choose the task on {row.hostLabel} that owns this work.</Text>
      <TextInput accessibilityLabel="Find a primary task" placeholder="Find by ticket, title or task ID" value={search} onChangeText={setSearch} editable={!busy} placeholderTextColor={colors.foregroundMuted} style={{ color: colors.foreground, borderColor: colors.border, borderWidth: 1, borderRadius: 6, padding: 10 }} />
      {choices.slice(0, 8).map(choice => <View key={choice.row.key} style={{ gap: 2 }}>
        <CompactLink label={choice.row.entry.task.title.includes(name(choice)) ? choice.row.entry.task.title : `${name(choice)} · ${choice.row.entry.task.title}`} colors={colors} selected={selection === choice.row.entry.task.taskId} disabled={busy} onPress={() => setSelection(choice.row.entry.task.taskId)} />
        <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{choice.row.entry.task.taskId}</Text>
      </View>)}
      {!choices.length ? <Text style={{ color: colors.foregroundMuted }}>No eligible tasks match.</Text> : choices.length > 8 ? <Text style={{ color: colors.foregroundMuted }}>Showing 8 of {choices.length}. Refine your search to find another task.</Text> : null}
      {current ? <CompactLink label="Remove link" colors={colors} selected={!selection} disabled={busy} onPress={() => setSelection(null)} /> : null}
      {changed ? <CompactLink label="Task changed · reload selection" colors={colors} disabled={busy} onPress={begin} /> : null}
      <CompactLink label={busy ? "Saving…" : selection && target ? `Save link to ${name(target)}` : !selection && current ? "Save removal" : "Save link"} selected colors={colors} disabled={busy || !dirty || changed} onPress={() => void save()} />
    </> : null}
    {message ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foreground }}>{message}</Text> : null}
  </View>;
}
