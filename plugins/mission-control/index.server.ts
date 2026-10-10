import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  createTaskRecord,
  listTaskDocumentRecords,
  listTaskRecords,
  readTaskSummary,
  taskSources,
  localServerId,
  attachTaskWorktree,
  saveTaskDocumentRecord,
  updateTaskStatusRecord,
  updateTaskDueDateRecord,
  deliverTaskSource,
  recordTaskPullRequest,
} from "./server/tasks";
import { createTask, listTaskDocuments, listTasks, saveTaskDocument, updateTaskDueDate, updateTaskStatus } from "./shared/tasks";
import { listRunRecords, runRecordsOf, taskAgentPrompt } from "./server/runs";
import { agentRuns, createClaimHandler } from "./server/agents-panel";
import { agentsPanelSettings, claimAgentsPanelWorkspaces, listAgentRuns } from "./shared/agents-panel";
import { getTaskSummary } from "./shared/task-summary";
import { listTaskRuns, resolveTaskPrompt } from "./shared/runs";
import { getTaskLaunch, launchTask } from "./shared/launch";
import { createTaskLauncher } from "./server/launch";
import { projectRoot, registerProjectGit, resolveDefaultBranch } from "./server/project-git";
import { registerBranchNames } from "./server/branch-names";
import { registerToolsInventory } from "./server/tools-inventory";
import { ensureStableKit, localSetupHost, registerSetup } from "./server/setup";
import { createTaskWorktree } from "./server/worktree";
import { createDecisionStore, profileKitRoot } from "./server/decisions";
import { listDecisions, resendDecision, resolveDecision } from "./shared/decisions";
import { createQuestionStore } from "./server/questions";
import { createNeedsYouTimeline } from "./server/needs-you-timeline";
import { listWaiting, replyToQuestion } from "./shared/questions";
import { createMergeService } from "./server/merge";
import { checkMerge, listMergeReady, runMerge } from "./shared/merge";
import { createPullRequestService, projectRemotes } from "./server/pull-request";
import { checkPullRequest, dismissDeliveryResult, listDeliveryResults, listPullRequests, planCleanup, runCleanup, runPullRequest } from "./shared/pull-request";
import { createDeliveryResults, defaultResultsFile } from "./server/delivery-results";
import { deliveryFor, deliverySettings, listProjectRemotes } from "./shared/delivery";
import { detectForge } from "./shared/forges";
import { getDeliveryInstructions, listBranchGuidance } from "./shared/paseo-metadata";
import { createPaseoInstructions } from "./server/paseo-config";
import type { PaseoApi } from "@getpaseo/client";
import { registerReview } from "./server/review-rpc";
import { registerMorning } from "./server/morning";
import { registerWorkflowInstructions } from "./server/workflow-instructions";
import { registerAgentCleanup } from "./server/agent-cleanup";
import { registerOrchestrator } from "./server/orchestrator";
import { getMissionSummary } from "./shared/mission";
import { renameAgent } from "./shared/agent-names";
import { daemonServerId, renameAgentRecord, setAgentNameViaDaemon } from "./server/agent-names";
import { createHelperService } from "./server/subagents";
import { listHelpers, listTaskTitles, readHelperMessages } from "./shared/subagents";

import { missionPreferences } from "./shared/preferences";
import { createPluginUpdater } from "./server/plugin-updates";
import { applyPluginUpdate, checkPluginUpdate } from "./shared/plugin-updates";
import { createVaultStore } from "./server/vault";
import { defaultVaultPath, getVaultStatus, initializeVault, listVaultFolder, readVaultFile, saveVaultFile, createVaultEntry, moveVaultEntry, trashVaultEntry, locateTaskInVault } from "./shared/vault";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(missionPreferences);
  const review = registerReview(server, defaultVaultPath);
  registerMorning(server);
  registerWorkflowInstructions(server);
  registerOrchestrator(server);
  const projectGit = registerProjectGit(server);
  const branchNames = registerBranchNames(server);
  registerToolsInventory(server);
  // Setup shows the forge tools (gh, az, Bitbucket credentials) only for forges this host's projects use.
  registerSetup(server, undefined, { forgesInUse: paseo => forgesInUse(paseo) });
  // After an update the install folder is new; move the stable kit link to it before anything uses kitRoot.
  void ensureStableKit(localSetupHost()).then(
    result => { if (result.status !== "installed" && result.target) console.warn(`[mission-control] stable kit: ${result.detail}`); },
    error => console.warn(`[mission-control] stable kit link couldn't be updated: ${error instanceof Error ? error.message : String(error)}`),
  );
  const launcher = createTaskLauncher({
    // New task branches follow the project's or host's branch-name template.
    branchPreview: (task, serverId, sourceCwd) => branchNames.preview(task, serverId, sourceCwd),
    // New task worktrees start from the project's freshly fetched default branch.
    createWorktree: async (input, paseo) => createTaskWorktree({ ...input, defaultBranch: await projectGit.defaultBranchFor(input.task.projectId) }, paseo),
    // A task's new worktree reviews everything since it branched, including later commits.
    async attachWorktree(input) {
      const task = await attachTaskWorktree(input);
      await review.marks.setBranchBase(input.worktree.workspaceId, input.worktree.baseCommit);
      return task;
    },
  });
  server.handle(getTaskLaunch, (input, { paseo }) => launcher.status(input, paseo));
  server.handle(launchTask, (input, { paseo }) => launcher.dispatch(input, paseo));
  const decisions = createDecisionStore({ sources: taskSources, kitRoot: source => profileKitRoot(defaultVaultPath, source.task.projectId) });
  const needsYouTimeline = createNeedsYouTimeline(localServerId);
  server.handle(listDecisions, async ({ serverId }, { paseo }) => {
    const result = await decisions.list(serverId);
    await needsYouTimeline.decisions(result.open, paseo);
    return result;
  });
  server.handle(resolveDecision, (input, { paseo }) => decisions.resolve(input, paseo));
  server.handle(resendDecision, (input, { paseo }) => decisions.resend(input, paseo));
  // Questions agents recorded with dev-flow ask, shown in Attention as Waiting for you, and the user's replies.
  const questions = createQuestionStore({ sources: taskSources });
  server.handle(listWaiting, async ({ serverId }, { paseo }) => {
    const result = await questions.list(serverId);
    await needsYouTimeline.questions(result.questions, paseo);
    return result;
  });
  server.handle(replyToQuestion, (input, { paseo }) => questions.reply(input, paseo));
  // Settings → Delivery: Merge, or a draft pull request, per project.
  const deliverySettingsStore = server.registerSettings(deliverySettings);
  async function deliveryOf(projectId: string) {
    const current = await deliverySettingsStore.read();
    if (current.status !== "ready") throw new Error(`Mission Control's delivery settings can't be read: ${current.error}`);
    return deliveryFor(current.values, projectId);
  }
  // The forges this host's projects use, as Open PR would detect them; null when the settings can't be read.
  async function forgesInUse(paseo: PaseoApi) {
    const current = await deliverySettingsStore.read();
    if (current.status !== "ready") return null;
    const found = (await projectRemotes(paseo)).flatMap(project => {
      const repo = project.remote ? detectForge(project.remote, deliveryFor(current.values, project.projectId).forge) : null;
      return repo ? [repo] : [];
    });
    return {
      forges: new Set(found.map(repo => repo.forge)),
      githubHosts: [...new Set(found.flatMap(repo => repo.forge === "github" ? [repo.host] : []))],
      azureOrganizations: [...new Set(found.flatMap(repo => repo.forge === "azure-devops" ? [repo.organizationUrl] : []))],
    };
  }
  server.handle(listProjectRemotes, async (_input, { paseo }) => ({ projects: await projectRemotes(paseo) }));
  // Every Merge, Open PR and Clean up result stays in Attention, and on disk, until dismissed.
  const results = createDeliveryResults({ file: defaultResultsFile() });
  // Attention's Merge action: checks first, then commit, merge --no-ff and clean up.
  const merges = createMergeService({
    results,
    deliveryMode: async projectId => (await deliveryOf(projectId)).mode,
    sources: taskSources,
    decisions: serverId => decisions.list(serverId, Infinity),
    projectRoot: (projectId, paseo) => projectRoot(paseo, projectId),
    clearReviewMarks: workspaceId => review.marks.clear(workspaceId),
    deliver: deliverTaskSource,
  });
  server.handle(checkMerge, (input, { paseo }) => merges.check(input, paseo));
  // Replies within 20 s; a slower merge finishes in the background and reports through merge.progress.
  server.handle(runMerge, (input, { paseo }) => merges.start(input, paseo));
  server.handle(listMergeReady, ({ serverId }) => merges.ready(serverId));
  // Attention's Open PR action for pull-request projects, the pull requests' states, and Clean up after one merges.
  const pullRequests = createPullRequestService({
    results,
    sources: taskSources,
    evaluate: (serverId, taskId, paseo, mode) => merges.evaluate(serverId, taskId, paseo, mode),
    delivery: deliveryOf,
    targetBranch: async (projectId, root) => (await resolveDefaultBranch(root, await projectGit.defaultBranchFor(projectId), false))?.branch ?? null,
    projectRoot: (projectId, paseo) => projectRoot(paseo, projectId),
    record: recordTaskPullRequest,
    deliver: deliverTaskSource,
    clearReviewMarks: workspaceId => review.marks.clear(workspaceId),
  });
  registerAgentCleanup(server, { decisions, questions, pullRequests });
  server.handle(checkPullRequest, (input, { paseo }) => pullRequests.check(input, paseo));
  server.handle(runPullRequest, (input, { paseo }) => pullRequests.start(input, paseo));
  server.handle(listPullRequests, input => pullRequests.list(input));
  server.handle(planCleanup, (input, { paseo }) => pullRequests.cleanupPlan(input, paseo));
  server.handle(runCleanup, (input, { paseo }) => pullRequests.cleanup(input, paseo));
  server.handle(listDeliveryResults, async () => ({ results: await results.list() }));
  // paseo.json's instructions (read only): Merge's and Open PR's confirmations write their text from them, and
  // Settings → Branch names shows each project's branch name guidance.
  const paseoInstructions = createPaseoInstructions({ sources: taskSources, projectRoot: (projectId, paseo) => projectRoot(paseo, projectId) });
  server.handle(getDeliveryInstructions, (input, { paseo }) => paseoInstructions.forTask(input, paseo));
  server.handle(listBranchGuidance, (_input, { paseo }) => paseoInstructions.branchGuidance(paseo));
  server.handle(dismissDeliveryResult, async ({ resultId }) => ({ dismissed: await results.dismiss(resultId) }));
  server.handle(getMissionSummary, async ({ workspaceIds }, { paseo }) => {
    const serverId = await localServerId();
    const summaries = Object.fromEntries(workspaceIds.map(id => [id, { openDecisions: 0, activeTasks: 0 }]));
    const open = (await decisions.list(serverId)).open;
    await needsYouTimeline.decisions(open, paseo);
    for (const entry of open) {
      if (summaries[entry.decision.workspaceId]) summaries[entry.decision.workspaceId].openDecisions++;
    }
    for (const source of await taskSources(serverId)) {
      if (source.task.status === "delivered" || source.task.status === "closed") continue;
      for (const assignment of source.task.assignments) {
        if (assignment.serverId === serverId && summaries[assignment.workspaceId]) summaries[assignment.workspaceId].activeTasks++;
      }
    }
    return { serverId, summaries };
  });
  const vault = createVaultStore(defaultVaultPath);
  server.handle(getVaultStatus, () => vault.status());
  server.handle(initializeVault, () => vault.initialize());
  server.handle(listVaultFolder, ({ path }) => vault.list(path));
  server.handle(readVaultFile, ({ path }) => vault.read(path));
  server.handle(saveVaultFile, input => vault.save(input));
  server.handle(createVaultEntry, input => vault.create(input));
  server.handle(moveVaultEntry, input => vault.move(input));
  server.handle(trashVaultEntry, input => vault.trash(input));
  server.handle(locateTaskInVault, ({ taskId }) => vault.locateTask(taskId));
  server.handle(getTaskSummary, ({ serverId }) => readTaskSummary(serverId));
  server.handle(listTasks, ({ serverId, workspaceId }) => listTaskRecords(serverId, workspaceId));
  server.handle(createTask, async (input, { paseo }) => {
    const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
    if (!workspace) throw new Error("Workspace is unavailable on this host.");
    return createTaskRecord(input, workspace.projectId);
  });
  server.handle(listTaskDocuments, async ({ serverId, workspaceId, taskId }) =>
    listTaskDocumentRecords(serverId, workspaceId, taskId),
  );
  server.handle(saveTaskDocument, async input => saveTaskDocumentRecord(input));
  server.handle(updateTaskStatus, async input => updateTaskStatusRecord(input));
  server.handle(updateTaskDueDate, async input => updateTaskDueDateRecord(input));
  server.handle(listTaskRuns, async ({ serverId, workspaceId, taskId }) => ({
    runs: await listRunRecords(serverId, workspaceId, taskId),
  }));
  server.handle(resolveTaskPrompt, async ({ workspaceId, taskId }) => taskAgentPrompt(workspaceId, taskId));
  server.handle(renameAgent, (input, { paseo }) => renameAgentRecord(input, paseo, { localServerId: () => daemonServerId(), setAgentName: setAgentNameViaDaemon }));
  // Helpers inside agents' turns, and task titles for sub-agents' context lines.
  const helpers = createHelperService();
  server.handle(listHelpers, input => helpers.list(input));
  server.handle(readHelperMessages, input => helpers.messages(input));
  server.handle(listTaskTitles, async ({ serverId }) => ({
    titles: Object.fromEntries((await taskSources(serverId)).map(source => [source.task.taskId, source.task.title])),
  }));
  // The Agents panel: its auto-open setting and record, and each agent's latest run.
  server.registerSettings(agentsPanelSettings);
  server.handle(claimAgentsPanelWorkspaces, createClaimHandler());
  server.handle(listAgentRuns, async ({ serverId }) => ({ runs: await agentRuns(await taskSources(serverId), source => runRecordsOf(source, serverId)) }));
  const updater = createPluginUpdater();
  server.handle(checkPluginUpdate, () => updater.check());
  server.handle(applyPluginUpdate, ({ target }) => updater.apply(target));
  return () => {};
}
