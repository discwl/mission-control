import { chatNativeCommand } from "../shared/chat-workflow";
import { chatReviewDetails } from "../shared/chat-presentations";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PaseoApi } from "@getpaseo/client";
import type { createDecisionStore } from "./decisions";
import type { createPullRequestService } from "./pull-request";
import type { createQuestionStore } from "./questions";
import { listWaiting, replyToQuestion } from "../shared/questions";
import { homedir } from "node:os";
import { join } from "node:path";
import { chatCommand, chatInbox, CHAT_HELP } from "../shared/chat-workflow";
import { listDecisions, resolveDecision } from "../shared/decisions";
import { readDecisionPlan } from "../shared/plan-approval";
import { checkPullRequest, runPullRequest } from "../shared/pull-request";
import { chatLinks, chatPlan, chatPullRequest, chatReview } from "../shared/chat-presentations";
import { createChatActions } from "./chat-actions";
import { createOrchestratorWorkStore } from "./orchestrator-work";
import { readOrchestratorBindings } from "./orchestrator";
import { daemonServerId } from "./agent-names";
import { invokeChatHost } from "./chat-transport";
import { manageChatCommand } from "./chat-management";
import { resolveChatReview } from "../shared/chat-review";
import { resolveCurrentChatReview } from "./chat-review";

// This RPC is a human UI/connector entry point, not an agent tool. In 0.13.2 timeline user
// messages do not identify their transport, so we deliberately do not scrape them for consent.
import { createFleetStore } from "./fleet-store";
import { PIPELINE_CHAT_HELP } from "./chat-pipeline";

export function registerChatWorkflow(server: PluginServerContext, deps: { decisions: ReturnType<typeof createDecisionStore>; pullRequests: ReturnType<typeof createPullRequestService>; questions: ReturnType<typeof createQuestionStore> }) {
  const offers = createChatActions(join(process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo"), "plugin-data", "mission-control", "chat-actions.json"));
  const links = createOrchestratorWorkStore();
  server.handle(resolveChatReview, (input, { paseo }) => resolveCurrentChatReview(input, paseo, deps.decisions));
  const handle = async ({ agentId, conversationId, text, offerId }: RpcInput<typeof chatCommand>, { paseo }: { paseo: PaseoApi }): Promise<RpcOutput<typeof chatCommand>> => {
    const local = await daemonServerId();
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent?.workspaceId || agent.archivedAt) throw new Error("This coordinator chat is unavailable.");
    const bindingResult = await readOrchestratorBindings(paseo, [agent.workspaceId], { localServerId: async () => local });
    if (bindingResult.problems[agent.workspaceId]) throw new Error(bindingResult.problems[agent.workspaceId]);
    const binding = bindingResult.bindings[agent.workspaceId];
    const target = binding?.serverId ?? local;
    const label = binding?.label ?? "This host";
    const owner = `${local}/${agentId}/${conversationId ?? "native"}`;
    const localCalls: Record<string, (input: any) => Promise<unknown>> = {
      [listWaiting.name]: input => deps.questions.list(input.serverId),
      [resolveChatReview.name]: input => resolveCurrentChatReview(input, paseo, deps.decisions),
      [replyToQuestion.name]: input => deps.questions.reply(input, paseo),
      [listDecisions.name]: input => deps.decisions.list(input.serverId),
      [readDecisionPlan.name]: input => deps.decisions.plan(input),
      [resolveDecision.name]: input => deps.decisions.resolve(input, paseo),
      [checkPullRequest.name]: input => deps.pullRequests.check(input, paseo),
      [runPullRequest.name]: input => deps.pullRequests.start(input, paseo),
    };
    const call = async <T>(contract: { name: string; input: { parse(input: unknown): unknown }; output: { parse(input: unknown): T } }, input: unknown): Promise<T> => {
      const parsed = contract.input.parse(input);
      const result = target !== local ? await invokeChatHost(target, contract.name, parsed) : await localCalls[contract.name](parsed);
      return contract.output.parse(result);
    };
    {
      const command = text.trim();
      if (/^(help|\?)$/i.test(command)) return { text: `${CHAT_HELP}\nreview details <ticket or task ID> — open the full technical report\n${PIPELINE_CHAT_HELP}` };
      const detailRequest = /^proposal details ([a-f0-9]{10})$/i.exec(command);
      if (detailRequest) {
        const offer = await offers.details(owner, detailRequest[1]);
        if (!offer || offer.target !== target) return { text: "This proposal expired or was replaced. Show a fresh plan/review; nothing was approved." };
        if (offer.state !== "pending") return { text: offer.receipt ?? "This action may already have run. Check its task before retrying.", offerId: offer.id, state: offer.state, proposalKind: offer.kind };
        let detail = offer.text;
        if (offer.kind === "review") {
          const decisions = await call(listDecisions, { serverId: target });
          const entry = decisions.open.find(row => row.decision.decisionId === offer.input.decisionId && row.revision === offer.input.expectedRevision);
          if (!entry) return { text: "This review changed or was resolved. Show the current review; nothing was approved." };
          detail = chatReviewDetails(entry, label);
        }
        return { text: detail, offerId: offer.id, state: offer.state, proposalKind: offer.kind };
      }
      const management = await manageChatCommand(command, { local, target, agentId, label, orchestrator: Boolean(binding) });
      if (management) return management;
      if (/^(yes\b|approve\b|accept\b|request changes\b|changes:|change the plan:|stop:|answer:|open draft pr\b)/i.test(command)) {
        return await offers.answer(owner, command, async (offer, consent) => {
          if (offer.target !== target) throw new Error("This chat's host changed. Show the proposal again.");
          if (offer.kind === "question") {
            const result = await call(replyToQuestion, { ...offer.input, text: consent.note });
            return `${label} · ${offer.title}\nAnswer ${result.question.status === "answered" ? "recorded" : "submitted"}.\n${chatLinks(target, result.question.workspaceId, result.question.agentId)}`;
          }
          if (offer.kind === "draft-pr") {
            const reply = await call(runPullRequest, { ...offer.input, dryRun: false });
            const result = reply.outcome === "opened" ? `Draft PR #${reply.number} opened: ${reply.url}\nPushed ${reply.pushed}.` : reply.outcome === "running" ? `Delivery is running: ${reply.step}. Receipt: ${reply.resultId}.` : reply.outcome === "refused" || reply.outcome === "failed" ? `${reply.outcome === "refused" ? "Refused" : "Stopped"}: ${reply.reason}` : "Dry run completed; nothing was published.";
            return `${label} · ${offer.title}\nProposal ${offer.id}\n${result}\nCheck the delivery result before repeating any publication request.`;
          }
          const resolved = await call(offer.kind === "review" && consent.outcome === "approved" ? resolveChatReview : resolveDecision, { ...offer.input, outcome: consent.outcome, note: consent.note, submitFindingIds: consent.outcome === "changes_requested" ? offer.input.changeFindingIds ?? [] : [] });
          return `${label} · ${offer.title}\n${resolved.decision.status === "approved" ? "Approved" : resolved.decision.status === "changes_requested" ? "Changes requested" : "Stopped"} · proposal ${offer.id}\n${resolved.decision.resume?.phase === "pending" ? "Recorded; worker resume is pending." : `Worker resume: ${resolved.decision.resume?.phase ?? "not requested"}`}${resolved.decision.resume?.error ? `\n${resolved.decision.resume.error}` : ""}\n${chatLinks(target, resolved.decision.workspaceId, resolved.decision.agentId)}\nNo additional delivery action was authorized.`;
        }, offerId);
      }
      const draft = /^draft pr\s+(task_[a-f0-9-]+)$/i.exec(command);
      if (draft) {
        const status = await call(checkPullRequest, { serverId: target, taskId: draft[1] });
        if (!status.ready || !status.plan) return { text: `${label} · Draft PR is not ready.\n${status.checks.map(check => Object.values(check).filter(value => typeof value === "string").join(": ")).join("\n")}` };
        const plan = status.plan;
        const offer = await offers.prepare({ owner, target, title: plan.taskTitle, kind: "draft-pr", text: chatPullRequest(plan, label), input: { serverId: target, taskId: draft[1], fingerprint: plan.fingerprint, title: plan.title, body: plan.body, commitMessage: plan.commitMessage } });
        return { text: `${offer.text}\n\nTo authorize these exact actions, reply: open draft PR ${offer.id}\n${chatLinks(target, plan.worktreeWorkspaceId)}`, offerId: offer.id, state: offer.state, proposalKind: offer.kind };
      }
      const questionCommand = /^question\s+(.+)$/i.exec(command);
      if (questionCommand) {
        const waiting = await call(listWaiting, { serverId: target });
        const query = questionCommand[1].trim().toLowerCase();
        const matches = waiting.questions.filter(entry => entry.question.status === "open" && (entry.question.taskId.toLowerCase() === query || entry.question.questionId === query || entry.taskTitle.toLowerCase().includes(query)));
        if (matches.length !== 1) return { text: matches.length ? `Several questions match. Choose a question ID:\n${matches.map(entry => `${entry.taskTitle}: ${entry.question.questionId}`).join("\n")}` : "No current question matches. Use ‘needs’ to see what is waiting." };
        const entry = matches[0], q = entry.question;
        const offer = await offers.prepare({ owner, target, title: entry.taskTitle, kind: "question", text: `${label} · ${entry.taskTitle}\n\n${q.question}`, input: { serverId: target, workspaceId: q.workspaceId, taskId: q.taskId, runId: q.runId, questionId: q.questionId } });
        return { text: `${offer.text}\n\nReply: answer: <your answer>\nQuestion proposal ${offer.id}\n${chatLinks(target, q.workspaceId, q.agentId)}`, offerId: offer.id, state: offer.state, proposalKind: offer.kind };
      }
      const refreshPlan = /^refresh plan\s+(.+)$/i.exec(command);
      const details = /^review details\s+(.+)$/i.exec(command);
      const requested = /^(plan|review)\s+(.+)$/i.exec(details ? `review ${details[1]}` : refreshPlan ? `plan ${refreshPlan[1]}` : command);
      const all = /^all needs$/i.test(command);
      if (!requested && !all && !/^(needs|what needs me\??)$/i.test(command)) return { text: CHAT_HELP };
      const decisions = await call(listDecisions, { serverId: target });
      const owned = binding ? await links.list({ serverId: local, agentId, remoteServerId: target }) : [];
      const belongs = (entry: typeof decisions.open[number]) => binding
        ? owned.some(link => link.taskId === entry.decision.taskId || link.remoteAgentId === entry.decision.agentId)
        : entry.decision.workspaceId === agent.workspaceId;
      if (!requested) {
        const selected = decisions.open.filter(entry => all || belongs(entry));
        const waiting = await call(listWaiting, { serverId: target });
        const questions = waiting.questions.filter(entry => entry.question.status === "open" && (all || (binding ? owned.some(link => link.taskId === entry.question.taskId || link.remoteAgentId === entry.question.agentId) : entry.question.workspaceId === agent.workspaceId)));
        const questionText = questions.map(entry => `QUESTION · ${entry.taskTitle}\n${entry.question.question}\nShow it: question ${entry.question.questionId}`).join("\n\n");
        return { text: `${label} · ${all ? "All host work" : "This chat's work"}\n${selected.length ? selected.map(entry => `${entry.decision.kind.toUpperCase()} · ${entry.taskTitle}\n${entry.decision.taskId}\n${entry.decision.question}\nShow it: ${entry.decision.kind} ${entry.decision.taskId}`).join("\n\n") : "No linked plan or review decisions are waiting. Older tasks may need linking; use ‘all needs’ to find a specific task without changing its ownership."}\n\n${questionText}\n\nNative tool permissions still appear in Paseo.` };
      }
      const query = requested[2].trim().toLowerCase();
      const matching = decisions.open.filter(entry => entry.decision.kind === requested[1].toLowerCase() && (entry.decision.taskId.toLowerCase() === query || entry.decision.decisionId === query || entry.taskTitle.toLowerCase().includes(query)));
      if (matching.length !== 1) return { text: matching.length ? `Several tasks match. Use the exact task ID:\n${matching.map(entry => `${entry.taskTitle}: ${entry.decision.taskId}`).join("\n")}` : "No open decision matches that task. Use ‘needs’ or ‘all needs’ to see current requests." };
      const entry = matching[0];
      const d = entry.decision;
      if (details) return { text: `${chatReviewDetails(entry, label)}\n${chatLinks(target, d.workspaceId, d.agentId)}` };
      const ref = { serverId: target, workspaceId: d.workspaceId, taskId: d.taskId, runId: d.runId, decisionId: d.decisionId, expectedRevision: entry.revision };
      if (refreshPlan) {
        const result = await call(resolveDecision, { ...ref, outcome: "changes_requested", note: "Please reissue this plan in the same task with a fresh versioned plan and a complete human-readable approval brief. Explain the goal, before/after behavior, scope, deferred work, approach, checks and risks. Preserve existing work and history. Wait for my approval before implementation; no publication is authorized.", submitFindingIds: [] });
        return { text: `${label} · ${entry.taskTitle}\nReadable plan requested in the existing task. Worker resume: ${result.decision.resume?.phase ?? "pending"}. No implementation or publication was approved.` };
      }
      let presentation: string;
      let expectedPlanRevision: string | undefined;
      if (d.kind === "plan") {
        const plan = await call(readDecisionPlan, ref);
        if (!plan.canApprove || !plan.brief || !plan.revision) return { text: `${label} · ${entry.taskTitle}\nThis plan needs a fresh readable proposal before it can be approved.\n${plan.warning ?? "The saved approval brief is missing."}\nAsk the existing worker to reissue its plan in the same task; its code and history are preserved.\n${chatLinks(target, d.workspaceId, d.agentId)}` };
        presentation = chatPlan(entry.taskTitle, label, plan.brief, plan.revision);
        expectedPlanRevision = plan.revision;
      } else {
        presentation = chatReview(entry, label);
      }
      const offer = await offers.prepare({ owner, target, title: entry.taskTitle, kind: d.kind, text: presentation, input: { ...ref, ...(d.candidate ? { expectedCandidate: d.candidate } : {}), changeFindingIds: entry.findings.filter(finding => finding.status === "open").map(finding => finding.findingId), ...(expectedPlanRevision ? { expectedPlanRevision } : {}) } });
      return { text: `${offer.text}\n\nProposal ${offer.id}\nReply: yes approve ${offer.id}\nOr: request changes: <what to change>\nOr: stop: <reason>\n${chatLinks(target, d.workspaceId, d.agentId)}`, offerId: offer.id, state: offer.state, proposalKind: offer.kind };
    }
  };
  server.handle(chatCommand, handle);
  server.handle(chatNativeCommand, async (input, context) => {
    const reply = await handle(input, context);
    await context.paseo.agents.ref(input.agentId).timeline.append({ type: "plugin", id: `mc-chat:${Date.now()}:${Math.random().toString(36).slice(2)}`, kind: "chat-workflow", version: 1, data: { text: reply.text, ...(reply.offerId ? { offerId: reply.offerId } : {}) } });
    return reply;
  });
  const inbox = async (input: RpcInput<typeof chatInbox>, { paseo }: { paseo: PaseoApi }): Promise<RpcOutput<typeof chatInbox>> => {
    const local = await daemonServerId();
    const agent = (await paseo.agents.ref(input.agentId).refresh())?.agent;
    if (!agent?.workspaceId || agent.archivedAt) return { entries: [] };
    const bindings = await readOrchestratorBindings(paseo, [agent.workspaceId], { localServerId: async () => local });
    const binding = bindings.bindings[agent.workspaceId];
    if (!binding) return { entries: [] };
    const target = binding.serverId;
    const owned = await links.list({ serverId: local, agentId: input.agentId, remoteServerId: target });
    const pipelines = (await createFleetStore().read()).pipelines.filter(row => row.coordinatorId === input.agentId && row.remoteServerId === target && !["done", "stopped"].includes(row.mode));
    if (!owned.length && !pipelines.length) return { entries: [] };
    const decisions = listDecisions.output.parse(await invokeChatHost(target, listDecisions.name, { serverId: target }));
    const waiting = listWaiting.output.parse(await invokeChatHost(target, listWaiting.name, { serverId: target }));
    const scoped = (taskId: string, worker: string | null) => pipelines.some(row => row.taskId === taskId) || owned.some(link => link.taskId === taskId || worker && link.remoteAgentId === worker);
    const requests = [
      ...pipelines.filter(row => row.mode === "ready" && !row.pending).map(row => ({ id: `${target}:pipeline:${row.id}:draft:${row.lastDispatch}`, command: `draft PR ${row.taskId}` })),
      ...decisions.open.filter(entry => scoped(entry.decision.taskId, entry.decision.agentId)).map(entry => ({ id: `${target}:${entry.decision.decisionId}:${entry.revision}`, command: `${entry.decision.kind} ${entry.decision.decisionId}` })),
      ...waiting.questions.filter(entry => entry.question.status === "open" && scoped(entry.question.taskId, entry.question.agentId)).map(entry => ({ id: `${target}:${entry.question.questionId}:${entry.question.askedAt}`, command: `question ${entry.question.questionId}` })),
    ];
    const entries: RpcOutput<typeof chatInbox>["entries"] = pipelines.filter(row => row.mode === "blocked").map(row => ({ id: `pipeline:${row.id}:blocked:${row.updatedAt}`, text: `${binding.label} · ${row.title}\nTask runner needs you\n${row.message}\nOpen Orchestrator → Run to draft PR to inspect it.\nStatus in chat: pipeline ${row.taskId}` }));
    for (const request of requests.slice(0, 30)) {
      const reply = await handle({ ...input, text: request.command }, { paseo });
      entries.push({ id: `${request.id}:${reply.offerId ?? "unavailable"}`, text: reply.text, ...(reply.offerId ? { offerId: reply.offerId } : {}), ...(reply.proposalKind ? { proposalKind: reply.proposalKind } : {}) });
    }
    return { entries };
  };
  server.handle(chatInbox, inbox);
  // Native chat gets the same saved brief when its coordinator completes a turn.
  // Stable timeline IDs make repeated observations update the existing card.
  const posted = new Set<string>();
  server.on("agent.turn_ended", async (event, { paseo }) => {
    if (event.outcome.kind !== "completed") return;
    const result = await inbox({ agentId: event.agent.id }, { paseo });
    for (const entry of result.entries) {
      const id = `mc-inbox:${event.agent.id}:${entry.id}`;
      if (posted.has(id)) continue;
      await paseo.agents.ref(event.agent.id).timeline.append({ type: "plugin", id, kind: "chat-workflow", version: 1, data: { text: entry.text, ...(entry.offerId ? { offerId: entry.offerId } : {}) } });
      posted.add(id);
    }
  });
}
