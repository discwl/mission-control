import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { MissionControl } from "./client/mission-control";
import { WorkspaceTasks } from "./client/workspace-tasks";
import { resolveTaskPrompt } from "./shared/runs";
import { WorkspaceReview } from "./client/review-panel";
import { startReviewPills } from "./client/review-pills";

import { agentReviewPanelId, hostAgentsPanelId, missionPanelId, reviewPanelId } from "./client/panel-ids";
import { HostAgentsPanel } from "./client/host-agents-panel";
import { createBindingLookup } from "./client/orchestrator-bindings";
import { startCopyRegistration } from "./client/host-bridge";
import { startOrchestratorPills } from "./client/orchestrator-pills";
import { readHostActivity } from "./client/roster";
import { MissionPanel } from "./client/mission-panel";
import { startMissionButtons } from "./client/mission-buttons";
import { NeedsYouTimelineCard } from "./client/needs-you-timeline";
import { needsYouTimelineKind, needsYouTimelineSchema } from "./shared/needs-you-timeline";
import { setPluginClient } from "./client/plugin-client";
import { PluginSettings } from "./client/plugin-settings";
import { BranchSettings } from "./client/branch-settings";
import { DeliverySettings } from "./client/delivery-settings";
import { ToolsSettings } from "./client/tools-settings";
import { SetupSettings } from "./client/setup-settings";
import { WorkflowInstructionsSettings } from "./client/workflow-settings";
import { AgentCleanupSettings } from "./client/agent-cleanup";
import { AgentsPanel } from "./client/agents-panel";
import { AgentsSettings } from "./client/agents-settings";
import { startAgentsAutoOpen } from "./client/agents-auto-open";
import { agentsPanelId } from "./shared/agents-panel";

export default function contribute(client: PluginClientContext) {
  setPluginClient(client);
  const removeNeedsYouTimeline = client.addTimelineRenderer({ kind: needsYouTimelineKind, version: 1, schema: needsYouTimelineSchema, Component: NeedsYouTimelineCard });
  const removeSurface = client.addSurface("mission-control", MissionControl);
  const removeSidebarItem = client.addSidebarItem({
    id: "mission-control",
    title: "Mission Control",
    icon: "PanelsTopLeft",
    surface: "mission-control",
  });
  const removeReturnCommand = client.addCommandCenterItem({
    id: "back-to-mission-control",
    title: "Back to Mission Control",
    icon: "PanelsTopLeft",
    keywords: ["return", "back", "mission", "control"],
    context: "global",
    onSelect() { client.openSurface("mission-control"); },
  });
  const removeReturnSlash = client.addSlashCommand({
    name: "mission-control",
    description: "Return to your last Mission Control page",
    argumentHint: "",
    context: "workspace",
    onSubmit() { client.openSurface("mission-control"); },
  });
  const removeTasksPanel = client.addWorkspacePanel({
    id: "workspace-tasks",
    title: "Tasks",
    icon: "ListTodo",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: WorkspaceTasks,
  });
  const removeReviewPanel = client.addWorkspacePanel({
    id: reviewPanelId,
    title: "Review",
    icon: "FileDiff",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: WorkspaceReview,
  });
  // Same view, opened for one agent so its comments go to that agent by default.
  const removeAgentReviewPanel = client.addWorkspacePanel({
    id: agentReviewPanelId,
    title: "Review",
    icon: "FileDiff",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: WorkspaceReview,
  });
  const removeReviewSlash = client.addSlashCommand({
    name: "review",
    description: "Review this workspace's uncommitted changes",
    argumentHint: "",
    context: "agent",
    onSubmit({ openPanel }) {
      openPanel(agentReviewPanelId, { location: "workspace" });
    },
  });
  // Every host's copy of Mission Control in this app registers itself, so an orchestrator's Host agents tab
  // can show that host's Attention, Tasks, Review and Docs from the copy next to its vault and checkouts.
  const stopCopyRegistration = startCopyRegistration(client);
  // A workspace whose folder names a remote host in host.json orchestrates that host: its chats get the
  // host's bubbles, and the Host agents tab shows the host's workspaces and agents.
  const orchestratorBindings = createBindingLookup(client);
  const removeHostAgentsPanel = client.addWorkspacePanel({
    id: hostAgentsPanelId,
    title: "Host agents",
    icon: "Server",
    context: "workspace",
    locations: ["workspace"],
    Component: HostAgentsPanel,
  });
  const stopReviewPills = startReviewPills(client, undefined, async workspaceIds => new Set((await orchestratorBindings(workspaceIds)).keys()));
  const stopOrchestratorPills = startOrchestratorPills(client, { lookUp: orchestratorBindings, readHost: readHostActivity });
  // The Mission tab belongs in Paseo's right panel (Explorer), beside the chat.
  const removeMissionPanel = client.addWorkspacePanel({
    id: missionPanelId,
    title: "Mission",
    icon: "PanelsTopLeft",
    context: "workspace",
    locations: ["explorer", "workspace"],
    Component: MissionPanel,
  });
  const removeMissionSlash = client.addSlashCommand({
    name: "mission",
    description: "Open the Mission panel: what needs you, tasks, review and agents",
    argumentHint: "",
    context: "agent",
    onSubmit({ agent }) {
      if (!agent.workspaceId) throw new Error("This agent has no workspace.");
      client.openPanel(missionPanelId, { workspaceId: agent.workspaceId, location: "explorer" });
    },
  });
  const stopMissionButtons = startMissionButtons(client);
  // Every agent of the workspace as a tree, in Explorer.
  const removeAgentsPanel = client.addWorkspacePanel({
    id: agentsPanelId,
    title: "Agents",
    icon: "Network",
    context: "workspace",
    locations: ["explorer"],
    Component: AgentsPanel,
  });
  const removeAgentsCommand = client.addCommandCenterItem({
    id: "open-agents",
    title: "Open Agents",
    icon: "Network",
    keywords: ["agents", "sub-agents", "subagents", "crew", "tree", "helpers", "workspace"],
    context: "workspace",
    onSelect({ openPanel }) { openPanel(agentsPanelId, { location: "explorer" }); },
  });
  const agentsAutoOpen = startAgentsAutoOpen(client);
  function AgentsSettingsScreen(props: PluginSurfaceProps) {
    return <AgentsSettings {...props} onAutoOpenChange={agentsAutoOpen.setEnabled} />;
  }
  const removeTaskCommand = client.addSlashCommand({
    name: "mission-task",
    description: "Send a linked vault task to this agent",
    argumentHint: "<task-id>",
    context: "agent",
    async onSubmit({ args, agent, paseo, rpc }) {
      const taskId = args.trim();
      if (!/^task_[a-f0-9-]+$/.test(taskId)) throw new Error("Enter a Mission Control task ID, for example /mission-task task_123.");
      if (!agent.workspaceId) throw new Error("This agent has no workspace.");
      const { prompt } = await rpc(resolveTaskPrompt, { workspaceId: agent.workspaceId, taskId });
      await paseo.agents.ref(agent.id).send(`${prompt}\nYour Paseo agent ID is ${agent.id}. Pass --agent ${agent.id} to dev-flow.mjs start so the run identifies you.`);
    },
  });
  const removeSettings = client.addSettingsScreen({ id: "updates", title: "Updates & Git", icon: "CircleArrowUp", Component: PluginSettings });
  const removeBranchSettings = client.addSettingsScreen({ id: "branch-names", title: "Branch names", icon: "GitBranch", Component: BranchSettings });
  const removeDeliverySettings = client.addSettingsScreen({ id: "delivery", title: "Delivery", icon: "GitPullRequest", Component: DeliverySettings });
  const removeToolsSettings = client.addSettingsScreen({ id: "tools-skills", title: "Tools & skills", icon: "Wrench", Component: ToolsSettings });
  const removeWorkflowSettings = client.addSettingsScreen({ id: "workflow-instructions", title: "Workflow instructions", icon: "NotebookPen", Component: WorkflowInstructionsSettings });
  const removeCleanupSettings = client.addSettingsScreen({ id: "agent-cleanup", title: "Agent cleanup", icon: "BrushCleaning", Component: AgentCleanupSettings });
  const removeSetupSettings = client.addSettingsScreen({ id: "setup", title: "Setup", icon: "PackageCheck", Component: SetupSettings });
  const removeAgentsSettings = client.addSettingsScreen({ id: "agents-panel", title: "Agents panel", icon: "Network", Component: AgentsSettingsScreen });
  return () => {
    removeNeedsYouTimeline();
    removeAgentsSettings();
    agentsAutoOpen.dispose();
    removeAgentsCommand();
    removeAgentsPanel();
    removeSetupSettings();
    removeWorkflowSettings();
    removeCleanupSettings();
    removeToolsSettings();
    removeDeliverySettings();
    removeBranchSettings();
    removeSettings();
    stopMissionButtons();
    removeMissionSlash();
    removeMissionPanel();
    setPluginClient(null);
    stopOrchestratorPills();
    removeHostAgentsPanel();
    stopCopyRegistration();
    stopReviewPills();
    removeReviewSlash();
    removeReviewPanel();
    removeAgentReviewPanel();
    removeReturnSlash();
    removeReturnCommand();
    removeTaskCommand();
    removeTasksPanel();
    removeSidebarItem();
    removeSurface();
  };
}
