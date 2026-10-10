import { CompactLink } from "./compact-link";
import { CopyTaskId } from "./copy-task-id";
import { Breadcrumbs } from "./breadcrumbs";
import { ProjectGit } from "./project-git";
import { TaskFlowRow, TaskFlowDetail } from "./task-flow";
import { useHosts, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { copyText, TextInput } from "@getpaseo/plugin/client/react-native";
import { AppModal as Modal } from "./app-modal";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { taskSummaryKey } from "../shared/task-summary";
import { useState } from "react";
import { formatDateTime } from "./date-time";
import { pageKey } from "./page-memory";
import { usePageState } from "./page-state";
import { Pressable, Text, View } from "react-native";
import { PageScrollView as ScrollView } from "./page-state";
import { createTask, dueDateSchema, listTasks, updateTaskDueDate, updateTaskStatus, type TaskRecord } from "../shared/tasks";
import { byDueDate, dueLabel, localToday } from "../shared/due-date";
import { TaskLauncher } from "./task-launcher";
import { TaskProblems } from "./task-problems";
import { TicketLink } from "./ticket-link";
import { agentsForTask, useRoster } from "./roster";
import { SubagentsRow, useHelpers, useTaskTitles } from "./subagents";

const statusOptions: TaskRecord["status"][] = ["inbox", "ready", "in_progress", "blocked", "in_review", "delivered", "closed"];
const boardLanes: { title: string; statuses: TaskRecord["status"][] }[] = [
  { title: "Inbox", statuses: ["inbox", "ready"] },
  { title: "Doing", statuses: ["in_progress", "blocked"] },
  { title: "Review", statuses: ["in_review"] },
  { title: "Delivered", statuses: ["delivered", "closed"] },
];
type Colors = PluginWorkspacePanelProps["theme"]["colors"];

export function WorkspaceTasks(props: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(props.workspaceId, ({ name, title, projectId, projectDisplayName, status }) => ({ name, title, projectId, projectDisplayName, status }));
  return <MissionTasksEditor key={props.workspaceId} {...props} workspaceName={workspace?.title || workspace?.name || props.workspaceId} projectId={workspace?.projectId} projectName={workspace?.projectDisplayName ?? "Unknown project"} workspaceStatus={workspace?.status ?? "unknown"} />;
}

export function MissionTasksEditor({ theme, host, layout, navigation, workspaceId, workspaceName, projectId, projectName, workspaceStatus, embedded = false, onOpenDocs }:
  Pick<PluginWorkspacePanelProps, "theme" | "host" | "layout" | "workspaceId" | "navigation"> & { workspaceName: string; projectId?: string | null; projectName: string; workspaceStatus: string; embedded?: boolean; onOpenDocs?: (taskId: string) => void }) {
  const queryClient = useQueryClient();
  const readTasks = useRpc(listTasks);
  const writeTask = useRpc(createTask);
  const changeTaskStatus = useRpc(updateTaskStatus);
  const changeTaskDueDate = useRpc(updateTaskDueDate);
  const scope = pageKey(host.id, workspaceId, embedded ? "tasks" : "task-panel");
  // The Tasks tab opens on the board; the narrow workspace panel keeps the list, where board columns don't fit.
  const [taskView, setTaskView] = usePageState<"list" | "board">(`${scope}:view`, embedded ? "board" : "list");
  const [selectedTaskId, setSelectedTaskId] = usePageState<string | null>(`${scope}:selection`, null);
  const [search, setSearch] = usePageState(`${scope}:search`, "");
  const [activeOnly, setActiveOnly] = usePageState(`${scope}:active`, false);
  const [boardWidth, setBoardWidth] = useState(0);
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [dueDraft, setDueDraft] = useState("");
  const [dueError, setDueError] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["mission-control", "tasks", host.id, workspaceId], queryFn: () => readTasks({ serverId: host.id, workspaceId }), retry: false });
  const colors = theme.colors;
  const currentTasks = query.data?.tasks ?? [];
  const visibleTasks = currentTasks.filter(task => (!activeOnly || !["delivered", "closed"].includes(task.status)) && `${task.title} ${task.acceptanceCriteria} ${task.taskId}`.toLowerCase().includes(search.trim().toLowerCase())).sort(byDueDate);
  const today = localToday();
  const selectedTask = currentTasks.find(task => task.taskId === selectedTaskId);
  // A task's agents carry its ID as a label; their sub-agents show on the task's card.
  const online = useHosts().some(candidate => candidate.serverId === host.id && candidate.status === "online");
  const roster = useRoster(host.id, online);
  const agentsByTask = new Map(currentTasks.map(task => [task.taskId, agentsForTask(roster.data?.agents ?? [], task.taskId)]));
  const helpers = useHelpers(host.id, host.id, [...agentsByTask.values()].flat(), online);
  const taskTitles = useTaskTitles(host.id, host.id);
  const laneWidth = Math.max(250, (boardWidth - 30) / 4);
  const inputStyle = { color: colors.foreground, backgroundColor: colors.surface0, borderColor: colors.border, borderWidth: 1, borderRadius: 7, padding: 10, minHeight: 44 };

  const refreshTasks = () => Promise.all([query.refetch(), queryClient.invalidateQueries({ queryKey: taskSummaryKey(host.id) })]);

  async function addTask() {
    if (!title.trim() || !acceptanceCriteria.trim() || saving) return;
    setSaving(true); setSaveError(null);
    try {
      await writeTask({ serverId: host.id, workspaceId, title: title.trim(), acceptanceCriteria: acceptanceCriteria.trim() });
      setTitle(""); setAcceptanceCriteria(""); await refreshTasks(); setAdding(false);
    } catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }
  async function setStatus(task: TaskRecord, status: TaskRecord["status"]) {
    if (status === task.status || updatingTaskId) return;
    setUpdatingTaskId(task.taskId); setStatusError(null);
    try {
      await changeTaskStatus({ serverId: host.id, workspaceId, taskId: task.taskId, status, expectedUpdatedAt: task.updatedAt });
      await refreshTasks();
    } catch (error) { setStatusError(error instanceof Error ? error.message : String(error)); }
    finally { setUpdatingTaskId(null); }
  }
  async function setDueDate(task: TaskRecord, dueDate: string | null) {
    if (updatingTaskId) return;
    if (dueDate !== null && !dueDateSchema.safeParse(dueDate).success) { setDueError("Use a real date as YYYY-MM-DD, for example 2026-10-08."); return; }
    setUpdatingTaskId(task.taskId); setDueError(null);
    try {
      await changeTaskDueDate({ serverId: host.id, workspaceId, taskId: task.taskId, dueDate, expectedUpdatedAt: task.updatedAt });
      setDueDraft(dueDate ?? "");
      await refreshTasks();
    } catch (error) { setDueError(error instanceof Error ? error.message : String(error)); }
    finally { setUpdatingTaskId(null); }
  }
  function dueText(task: TaskRecord) {
    if (!task.dueDate) return null;
    const due = dueLabel(task.dueDate, today);
    const color = due.tone === "overdue" ? colors.statusDanger : due.tone === "soon" ? colors.statusWarning : colors.foregroundMuted;
    return <Text style={{ color, fontSize: 12, fontWeight: due.tone === "later" ? "400" : "600", paddingHorizontal: 10 }}>{due.text}</Text>;
  }
  function openAgent(agentId: string) {
    try { const target = { serverId: host.id, agentId, focusHost: true }; navigation?.openAgent(target); }
    catch (error) { setStatusError(error instanceof Error ? error.message : String(error)); }
  }
  function openTask(task: TaskRecord) { setSelectedTaskId(task.taskId); setStatusError(null); setCopyFeedback(null); setDueDraft(task.dueDate ?? ""); setDueError(null); }
  function taskCard(task: TaskRecord, board: boolean) {
    const linked = agentsByTask.get(task.taskId) ?? [];
    return <View key={task.taskId} style={{ gap: 5 }}>
      <TaskFlowRow task={task} binding={{ serverId: host.id, workspaceId, taskId: task.taskId }} online={online} colors={colors} selected={selectedTaskId === task.taskId} onPress={() => openTask(task)} liveCount={linked.filter(agent => agent.status === "running").length} />
      <Text numberOfLines={board ? 2 : 1} style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18, paddingHorizontal: 10 }}>{task.acceptanceCriteria}</Text>
      {dueText(task)}
      {roster.data ? <SubagentsRow serverId={host.id} parents={linked} agents={roster.data.agents} helpers={helpers} taskTitles={taskTitles} colors={colors} canNavigate={Boolean(navigation) && online} openAgent={openAgent} /> : null}
    </View>;
  }

  return <View style={{ flex: layout.compact && embedded ? undefined : 1, minHeight: 0, gap: 12, backgroundColor: embedded ? "transparent" : colors.surface0, padding: embedded ? 0 : 16 }}>
    {!embedded ? <View style={{ gap: 4 }}><Text style={{ color: colors.foreground, fontSize: 22, fontWeight: "600" }}>Workspace tasks</Text><Breadcrumbs colors={colors} segments={[host.label, projectName, workspaceName]} /><Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{workspaceStatus}</Text></View> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "600" }}>Tasks <Text style={{ color: colors.foregroundMuted, fontWeight: "400" }}>({visibleTasks.length})</Text></Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {(["list", "board"] as const).map(next => <Pressable key={next} accessibilityRole="button" accessibilityLabel={`${next} task view`} accessibilityState={{ selected: taskView === next }} onPress={() => setTaskView(next)} style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: "center", borderWidth: 1, borderRadius: 7, borderColor: taskView === next ? colors.accent : colors.border }}><Text style={{ color: taskView === next ? colors.foreground : colors.foregroundMuted }}>{next === "list" ? "List" : "Board"}</Text></Pressable>)}
        <Pressable accessibilityRole="button" onPress={() => setAdding(true)} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12, backgroundColor: colors.accent, borderRadius: 7 }}><Text style={{ color: colors.accentForeground, fontWeight: "600" }}>+ Task</Text></Pressable>
      </View>
    </View>
    <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <TextInput accessibilityLabel="Search tasks" placeholder="Find a task" placeholderTextColor={colors.foregroundMuted} value={search} onChangeText={setSearch} style={{ ...inputStyle, flexGrow: 1, minWidth: 160 }} />
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: activeOnly }} onPress={() => setActiveOnly(!activeOnly)} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }}><Text style={{ color: activeOnly ? colors.accent : colors.foregroundMuted, fontSize: 12 }}>{activeOnly ? "☑" : "☐"} Active only</Text></Pressable>
      <CompactLink colors={colors} label={"Refresh"} accessibilityRole="button" onPress={() => void refreshTasks()} />
    </View>
    {query.isPending ? <Text style={{ color: colors.foregroundMuted }}>Loading vault tasks…</Text> : null}
    {query.isError ? <Text style={{ color: colors.statusDanger }}>Vault error: {query.error instanceof Error ? query.error.message : String(query.error)}</Text> : null}
    <TaskProblems problems={query.data?.problems} colors={colors} />
    {query.data && visibleTasks.length === 0 ? <Text style={{ color: colors.foregroundMuted }}>{currentTasks.length ? "No tasks match these filters." : "No tasks yet. Add a task to start."}</Text> : null}
    {projectId ? <ProjectGit projectId={projectId} projectName={projectName} local={online} colors={colors} /> : null}
    <View onLayout={event => setBoardWidth(event.nativeEvent.layout.width)} style={{ flex: layout.compact && embedded ? undefined : 1, minHeight: 0 }}>
      {taskView === "list" ? <ScrollView memoryKey={pageKey(scope, "list", search, String(activeOnly))} scrollEnabled={!(layout.compact && embedded)} style={{ flex: layout.compact && embedded ? undefined : 1, minHeight: 0 }} contentContainerStyle={{ gap: 9, paddingBottom: 10 }}>{visibleTasks.map(task => taskCard(task, false))}</ScrollView> :
        <ScrollView memoryKey={pageKey(scope, "board", search, String(activeOnly))} horizontal nestedScrollEnabled style={{ flex: layout.compact && embedded ? undefined : 1, minHeight: 0 }} contentContainerStyle={{ gap: 10, paddingBottom: 12, alignItems: "flex-start" }}>
          {boardLanes.map(lane => {
            const tasks = visibleTasks.filter(task => lane.statuses.includes(task.status));
            return <View key={lane.title} style={{ width: laneWidth, maxHeight: layout.compact ? undefined : "100%", borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 10, gap: 10, backgroundColor: colors.surface2 }}>
              <Text style={{ color: colors.foreground, fontWeight: "600" }}>{lane.title} ({tasks.length})</Text>
              <ScrollView nestedScrollEnabled scrollEnabled={!(layout.compact && embedded)} style={{ flexGrow: 0, minHeight: 100 }} contentContainerStyle={{ gap: 9, paddingBottom: 4 }}>
                {tasks.map(task => taskCard(task, true))}
                {!tasks.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No tasks</Text> : null}
              </ScrollView>
            </View>;
          })}
        </ScrollView>}
    </View>
    <Modal colors={colors} icon={selectedTask ? <CopyTaskId key={selectedTask.taskId} taskId={selectedTask.taskId} colors={colors} /> : undefined} title={selectedTask?.title ?? "Task details"} open={Boolean(selectedTask)} onOpenChange={open => { if (!open) setSelectedTaskId(null); }}>
      <Modal.Content>
        {selectedTask ? <View style={{ gap: 18 }}>
          <Breadcrumbs colors={colors} segments={[host.label, projectName, workspaceName]} />
          {selectedTask.ticket ? <TicketLink ticket={selectedTask.ticket} colors={colors} /> : null}
          <View style={{ gap: 8 }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>Acceptance criteria</Text><Text selectable style={{ color: colors.foreground, lineHeight: 22 }}>{selectedTask.acceptanceCriteria}</Text></View>
          <View style={{ gap: 8 }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>Status</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{statusOptions.map(status => <Pressable key={status} accessibilityRole="button" accessibilityLabel={`Set status to ${status.replaceAll("_", " ")}`} accessibilityState={{ selected: selectedTask.status === status }} disabled={updatingTaskId !== null} onPress={() => void setStatus(selectedTask, status)} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 10, borderWidth: 1, borderColor: selectedTask.status === status ? colors.accent : colors.border, borderRadius: 7 }}><Text style={{ color: colors.foreground, fontSize: 12 }}>{status.replaceAll("_", " ")}</Text></Pressable>)}</View>{updatingTaskId ? <Text style={{ color: colors.foregroundMuted }}>Updating…</Text> : null}{statusError ? <Text style={{ color: colors.statusDanger }}>{statusError}</Text> : null}</View>
          <View style={{ gap: 8 }}>
            <Text style={{ color: colors.foreground, fontWeight: "600" }}>Due date</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
              <TextInput accessibilityLabel="Due date" placeholder="YYYY-MM-DD" placeholderTextColor={colors.foregroundMuted} value={dueDraft} onChangeText={setDueDraft} maxLength={10} editable={updatingTaskId === null} style={{ ...inputStyle, width: 140 }} />
              <Pressable accessibilityRole="button" accessibilityLabel="Save due date" disabled={updatingTaskId !== null || !dueDraft.trim() || dueDraft.trim() === (selectedTask.dueDate ?? "")} onPress={() => void setDueDate(selectedTask, dueDraft.trim())} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 7 }}><Text style={{ color: colors.foreground, fontSize: 12 }}>Save</Text></Pressable>
              {selectedTask.dueDate ? <Pressable accessibilityRole="button" accessibilityLabel="Clear due date" disabled={updatingTaskId !== null} onPress={() => void setDueDate(selectedTask, null)} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 7 }}><Text style={{ color: colors.foreground, fontSize: 12 }}>Clear</Text></Pressable> : null}
              {selectedTask.dueDate ? dueText(selectedTask) : <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No due date</Text>}
            </View>
            {dueError ? <Text style={{ color: colors.statusDanger }}>{dueError}</Text> : null}
          </View>
          <TaskFlowDetail key={`flow:${host.id}:${workspaceId}:${selectedTask.taskId}`} task={selectedTask} binding={{ serverId: host.id, workspaceId, taskId: selectedTask.taskId }} online={online} colors={colors} hostLabel={host.label} openAgent={openAgent} />
          <TaskLauncher key={`${host.id}:${workspaceId}:${selectedTask.taskId}`} binding={{ serverId: host.id, workspaceId, taskId: selectedTask.taskId }} colors={colors} navigation={navigation} />
          <View style={{ gap: 7 }}><Text style={{ color: colors.foreground, fontWeight: "600" }}>Use a chat command instead</Text><Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>/mission-task {selectedTask.taskId}</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}><CompactLink colors={colors} label={"Copy command"} accessibilityRole="button" onPress={() => { void copyText(`/mission-task ${selectedTask.taskId}`).then(() => setCopyFeedback("Command copied"), () => setCopyFeedback("Could not copy. Select the command above.")); }} />{onOpenDocs ? <CompactLink colors={colors} label={"Open task documents →"} accessibilityRole="button" onPress={() => { setSelectedTaskId(null); onOpenDocs(selectedTask.taskId); }} /> : null}</View>{copyFeedback ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{copyFeedback}</Text> : null}</View>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Updated {formatDateTime(selectedTask.updatedAt)}</Text>
        </View> : null}
      </Modal.Content>
    </Modal>
    <Modal colors={colors} title="New task" open={adding} onOpenChange={open => { if (!saving) setAdding(open); }}><Modal.Content><View style={{ gap: 12 }}>
      <Breadcrumbs colors={colors} segments={[host.label, projectName, workspaceName]} />
      <TextInput accessibilityLabel="Task title" placeholder="Task title" placeholderTextColor={colors.foregroundMuted} value={title} onChangeText={setTitle} maxLength={200} editable={!saving} style={inputStyle} />
      <TextInput accessibilityLabel="Acceptance criteria" placeholder="What will prove this is done?" placeholderTextColor={colors.foregroundMuted} value={acceptanceCriteria} onChangeText={setAcceptanceCriteria} multiline maxLength={4000} editable={!saving} style={{ ...inputStyle, minHeight: 120, textAlignVertical: "top" }} />
      <Pressable accessibilityRole="button" disabled={saving || !title.trim() || !acceptanceCriteria.trim()} onPress={() => void addTask()} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 14, backgroundColor: colors.accent, borderRadius: 7, opacity: saving || !title.trim() || !acceptanceCriteria.trim() ? 0.5 : 1 }}><Text style={{ color: colors.accentForeground, fontWeight: "600" }}>{saving ? "Saving…" : "Add task"}</Text></Pressable>
      {saveError ? <Text style={{ color: colors.statusDanger }}>{saveError}</Text> : null}
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Creates a task folder in dev-vault on this host. Open its details to start an agent when you are ready.</Text>
    </View></Modal.Content></Modal>
  </View>;
}
