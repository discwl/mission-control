import { chatNativeCommand, chatContext } from "../shared/chat-workflow";
import { decisionContext, decisionReceipt } from "./chat-message";
import type { ChatMessageContext } from "../shared/chat-message";
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
import { checkActionDelivery, authorizeActionDelivery } from "../shared/action-delivery";
import type { createActionDeliveryService } from "./action-delivery";
import { INTAKE_CHAT_HELP } from "./chat-intake";

export function registerChatWorkflow(server: PluginServerContext, deps: { decisions: ReturnType<typeof createDecisionStore>; pullRequests: ReturnType<typeof createPullRequestService>; actionDelivery?: ReturnType<typeof createActionDeliveryService>; questions: ReturnType<typeof createQuestionStore> }) {
  const offers = createChatActions(join(process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo"), "plugin-data", "mission-control", "chat-actions.json"));
  const links = createOrchestratorWorkStore();
  server.handle(chatContext, async ({ agentId }, { paseo }) => {
    const local = await daemonServerId();
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!agent?.workspaceId || agent.archivedAt) throw new Error("Chat unavailable");
    const result = await readOrchestratorBindings(paseo, [agent.workspaceId], { localServerId: async () => local });
    if (result.problems[agent.workspaceId]) throw new Error(result.problems[agent.workspaceId]);
    return { host: result.bindings[agent.workspaceId]?.label ?? "This host" };
  });
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
      [checkActionDelivery.name]: input => { if (!deps.actionDelivery) throw new Error("Action delivery is unavailable."); return deps.actionDelivery.check(input, paseo); },
      [authorizeActionDelivery.name]: input => { if (!deps.actionDelivery) throw new Error("Action delivery is unavailable."); return deps.actionDelivery.authorize(input, paseo); },
    };
    const call = async <T>(contract: { name: string; input: { parse(input: unknown): unknown }; output: { parse(input: unknown): T } }, input: unknown): Promise<T> => {
      const parsed = contract.input.parse(input);
      const result = target !== local ? await invokeChatHost(target, contract.name, parsed) : await localCalls[contract.name](parsed);
      return contract.output.parse(result);
    };
    {
      const command = text.trim();
      if (/^(help|\?)$/i.test(command)) return { text: `${CHAT_HELP}\nreview details <ticket or task ID> — open the full technical report\n${PIPELINE_CHAT_HELP}\n${INTAKE_CHAT_HELP}` };
      const detailRequest = /^proposal details ([a-f0-9]{10})$/i.exec(command);
      if (detailRequest) {
        const offer = await offers.details(owner, detailRequest[1]);
        if (!offer || offer.target !== target) return { text: "This proposal expired or was replaced. Show a fresh plan/review; nothing was approved." };
        if (offer.state !== "pending") return { text: offer.receipt ?? "This action may already have run. Check its task before retrying.", offerId: offer.id, state: offer.state, proposalKind: offer.kind, context: offer.receiptContext ?? offer.context };
        let detail = offer.text;
        if (offer.kind === "review") {
          const decisions = await call(listDecisions, { serverId: target });
          const entry = decisions.open.find(row => row.decision.decisionId === offer.input.decisionId && row.revision === offer.input.expectedRevision);
          if (!entry) return { text: "This review changed or was resolved. Show the current review; nothing was approved." };
          detail = chatReviewDetails(entry, label);
        }
        return { text: detail, offerId: offer.id, state: offer.state, proposalKind: offer.kind, context: offer.context };
      }
      const management = await manageChatCommand(command, { local, target, agentId, label, orchestrator: Boolean(binding) });
      if (management) return management;
      if (/^(yes\b|approve\b|accept\b|request changes\b|changes:|change the plan:|stop:|answer:|open draft pr\b|authorize actions\b)/i.test(command)) {
        return await offers.answer(owner, command, async (offer, consent) => {
          if (offer.target !== target) throw new Error("This chat's host changed. Show the proposal again.");
          if (offer.kind === "question") {
            const result = await call(replyToQuestion, { ...offer.input, text: consent.note });
            const saved = result.savedForNextWorker === true;
            return { text: `${label} · ${offer.title}\n${saved ? "Answer saved for the task's next worker. The agent that asked is no longer available, so nothing was sent." : `Answer ${result.question.status === "answered" ? "recorded" : "submitted"}.`}\nThe task's overall completion has not changed.`, context: { host: label, title: offer.title, taskId: typeof offer.input.taskId === "string" ? offer.input.taskId : undefined, type: "receipt" as const, status: saved ? "Answer saved for the next worker" : result.question.status === "answered" ? "Answer recorded" : "Answer submitted", waitingOn: saved ? "Next worker" : "Worker", observedAt: new Date().toISOString(), evidence: "saved_record" as const } };
          }
          if (offer.kind === "actions") {
            const result = await call(authorizeActionDelivery, { ...offer.input, actorId: owner });
            return { text: `${label} · ${offer.title}\n${result.reason}`, context: { host: label, title: offer.title, taskId: String(offer.input.taskId), type: "receipt" as const, status: result.outcome === "resumed" ? "Actions authorized; worker resumed" : result.outcome === "uncertain" ? "Resume uncertain" : "Authorization refused", waitingOn: result.outcome === "resumed" ? "Worker" : "You", observedAt: new Date().toISOString(), evidence: "saved_record" as const } };
          }
          if (offer.kind === "draft-pr") {
            const reply = await call(runPullRequest, { ...offer.input, dryRun: false });
            const result = reply.outcome === "opened" ? `Draft PR #${reply.number} opened: ${reply.url}\nPushed ${reply.pushed}.` : reply.outcome === "running" ? `Delivery is running: ${reply.step}. Receipt: ${reply.resultId}.` : reply.outcome === "refused" || reply.outcome === "failed" ? `${reply.outcome === "refused" ? "Refused" : "Stopped"}: ${reply.reason}` : "Dry run completed; nothing was published.";
            return { text: `${label} · ${offer.title}\n${result}\nCheck the delivery result before repeating any publication request.\nA draft PR does not establish a merge, deployment, or customer enablement.`, context: { host: label, title: offer.title, taskId: typeof offer.input.taskId === "string" ? offer.input.taskId : undefined, type: "receipt" as const, stage: "Draft PR delivery", status: reply.outcome === "opened" ? "Draft PR opened" : reply.outcome === "running" ? "Delivery running" : reply.outcome === "refused" ? "Delivery refused" : reply.outcome === "failed" ? "Delivery stopped" : "Preview only", waitingOn: reply.outcome === "running" ? "Delivery worker" : "You", observedAt: new Date().toISOString(), evidence: "saved_record" as const } };
          }
          const resolved = await call(offer.kind === "review" && consent.outcome === "approved" ? resolveChatReview : resolveDecision, { ...offer.input, outcome: consent.outcome, note: consent.note, submitFindingIds: consent.outcome === "changes_requested" ? offer.input.changeFindingIds ?? [] : [] });
          return decisionReceipt(resolved, label);
        }, offerId);
      }
      const actionRequest = /^actions\s+(task_[a-f0-9-]+)$/i.exec(command);
      if (actionRequest) {
        const status = await call(checkActionDelivery, { serverId: target, taskId: actionRequest[1] });
        if (!status.ready || !status.plan) return { text: `${label} · ${status.reason}`, ...(status.authorized ? { authorized: true } : {}), ...(status.completed ? { completed: true } : {}), context: { host: label, title: status.plan?.title, taskId: actionRequest[1], type: status.completed ? "completion" : status.authorized ? "receipt" : "blocker", status: status.completed ? "Work completed" : status.authorized ? "Actions already authorized" : "Final actions need attention", waitingOn: status.completed ? "None" : "Worker", observedAt: new Date().toISOString(), evidence: "saved_record" } };
        const plan = status.plan;
        if (plan.kind === "report") return { text: `${label} · ${plan.title}\nReviewed report ${plan.revision}\n\n${plan.bundle.report}\n\n${status.reason}\nNo external actions were executed.`, completed: true, context: { host: label, title: plan.title, taskId: plan.taskId, type: "completion", status: "Reviewed read-only result", waitingOn: "None", observedAt: new Date().toISOString(), evidence: "saved_record" } };
        const preview = `${label} · ${plan.title}\nExact action bundle ${plan.revision}\nEnvironment: ${plan.bundle.environment}\n\n${plan.bundle.summary}\n\nPrerequisites\n${plan.bundle.prerequisites.join("\n")}\n\nActions\n${plan.bundle.steps.map((step, index) => `${index + 1}. ${step.instruction}\nExpected effect: ${step.effect}`).join("\n\n")}\n\nVerification\n${plan.bundle.verification.join("\n")}\n\nRollback\n${plan.bundle.rollback}\n\nThe exact bundle passed validation and two independent reviews. Authorization resumes the assigned worker; it does not establish successful execution.`;
        const offer = await offers.prepare({ owner, target, title: plan.title, kind: "actions", text: preview, input: { serverId: target, taskId: plan.taskId, fingerprint: plan.fingerprint }, context: { host: label, title: plan.title, taskId: plan.taskId, type: "delivery", stage: "Action preview", status: "Awaiting exact action authorization", waitingOn: "You", observedAt: new Date().toISOString(), evidence: "saved_record" } });
        return { text: `${offer.text}\n\nTo authorize these exact actions, reply: authorize actions ${offer.id}`, offerId: offer.id, state: offer.state, proposalKind: offer.kind, context: offer.receiptContext ?? offer.context };
      }
      const draft = /^draft pr\s+(task_[a-f0-9-]+)$/i.exec(command);
      if (draft) {
        const status = await call(checkPullRequest, { serverId: target, taskId: draft[1] });
        if (!status.ready || !status.plan) return { text: `${label} · Draft PR is not ready.\n${status.checks.map(check => Object.values(check).filter(value => typeof value === "string").join(": ")).join("\n")}`, context: { host: label, taskId: draft[1], type: "blocker", status: "Publication checks need attention", waitingOn: "Worker", actionNeeded: "Open the task in Paseo to inspect the failed checks", observedAt: new Date().toISOString(), evidence: "saved_record" } };
        const plan = status.plan;
        const offer = await offers.prepare({ owner, target, title: plan.taskTitle, kind: "draft-pr", context: { host: label, title: plan.taskTitle, taskId: draft[1], type: "delivery", stage: "Draft PR preview", status: "Awaiting publication approval", waitingOn: "You", actionNeeded: "Read the exact commit, push and draft PR preview", nextStep: "Publish only after your separate approval", observedAt: new Date().toISOString(), evidence: "saved_record" }, text: chatPullRequest(plan, label), input: { serverId: target, taskId: draft[1], fingerprint: plan.fingerprint, title: plan.title, body: plan.body, commitMessage: plan.commitMessage } });
        return { text: `${offer.text}\n\nTo authorize these exact actions, reply: open draft PR ${offer.id}\n${chatLinks(target, plan.worktreeWorkspaceId)}`, offerId: offer.id, state: offer.state, proposalKind: offer.kind, context: offer.receiptContext ?? offer.context };
      }
      const questionCommand = /^question\s+(.+)$/i.exec(command);
      if (questionCommand) {
        const waiting = await call(listWaiting, { serverId: target });
        const query = questionCommand[1].trim().toLowerCase();
        const matches = waiting.questions.filter(entry => entry.question.status === "open" && (entry.question.taskId.toLowerCase() === query || entry.question.questionId === query || entry.taskTitle.toLowerCase().includes(query)));
        if (matches.length !== 1) return { text: matches.length ? `Several questions match. Choose a question ID:\n${matches.map(entry => `${entry.taskTitle}: ${entry.question.questionId}`).join("\n")}` : "No current question matches. Use ‘needs’ to see what is waiting." };
        const entry = matches[0], q = entry.question;
        const offer = await offers.prepare({ owner, target, title: entry.taskTitle, kind: "question", context: { host: label, title: entry.taskTitle, taskId: q.taskId, type: "question", status: "Waiting for your answer", waitingOn: "You", actionNeeded: "Answer the saved question", observedAt: q.askedAt, evidence: "saved_record" }, text: `${label} · ${entry.taskTitle}\n\n${q.question}`, input: { serverId: target, workspaceId: q.workspaceId, taskId: q.taskId, runId: q.runId, questionId: q.questionId } });
        return { text: `${offer.text}\n\nReply: answer: <your answer>\nQuestion proposal ${offer.id}\n${chatLinks(target, q.workspaceId, q.agentId)}`, offerId: offer.id, state: offer.state, proposalKind: offer.kind, context: offer.receiptContext ?? offer.context };
      }
      const refreshPlan = /^refresh plan\s+(.+)$/i.exec(command);
      const details = /^review details\s+(.+)$/i.exec(command);
      const requested = /^(plan|review)\s+(.+)$/i.exec(details ? `review ${details[1]}` : refreshPlan ? `plan ${refreshPlan[1]}` : command);
      const receiptQuery = /^decision status ([\w-]+)$/i.exec(command);
      const all = /^all needs$/i.test(command);
      if (!requested && !receiptQuery && !all && !/^(needs|what needs me\??)$/i.test(command)) return { text: CHAT_HELP };
      const decisions = await call(listDecisions, { serverId: target });
      if (receiptQuery) {
        const found = decisions.recent.filter(row => row.decision.decisionId === receiptQuery[1] || row.decision.taskId === receiptQuery[1]);
        return found.length ? decisionReceipt(found[0], label, [...decisions.open, ...decisions.recent]) : { text: "No recent saved decision matches. Nothing was approved or resent." };
      }
      const owned = binding ? await links.list({ serverId: local, agentId, remoteServerId: target }) : [];
      const displayed = (await offers.forOwner(owner)).filter(offer => offer.target === target);
      if (!requested) {
        const pipelines = (await createFleetStore().read()).pipelines.filter(row => row.remoteServerId === target && (all || row.coordinatorId === agentId || owned.some(link => link.taskId === row.taskId) || displayed.some(offer => offer.input.taskId === row.taskId)));
        const belongs = (record: { serverId: string; workspaceId: string; taskId: string; agentId: string | null }) => record.serverId === target && (all || (binding
          ? pipelines.some(row => row.taskId === record.taskId) || owned.some(link => link.taskId === record.taskId || link.remoteAgentId === record.agentId) || displayed.some(offer => offer.input.taskId === record.taskId)
          : record.workspaceId === agent.workspaceId));
        const selected = decisions.open.filter(entry => belongs(entry.decision));
        const waiting = await call(listWaiting, { serverId: target });
        const questions = waiting.questions.filter(entry => entry.question.status === "open" && belongs(entry.question));
        const recent = decisions.recent.filter(entry => belongs(entry.decision));
        const finalReady = pipelines.filter(row => row.stage === "delivery" && row.mode === "ready" && !row.pending && row.deliveryKind !== "report" && !selected.some(entry => entry.decision.taskId === row.taskId) && !questions.some(entry => entry.question.taskId === row.taskId));
        const intervention = pipelines.filter(row => (row.mode === "blocked" || row.mode === "paused" || Boolean(row.pending)) && !selected.some(entry => entry.decision.taskId === row.taskId) && !questions.some(entry => entry.question.taskId === row.taskId));
        const rejectedFor = (entry: typeof selected[number]) => displayed.find(offer => offer.state === "rejected" && offer.input.decisionId === entry.decision.decisionId && offer.input.expectedRevision === entry.revision);
        const sections = [
          ...selected.map(entry => { const rejected = rejectedFor(entry); return rejected ? `**${entry.taskTitle}**\nReview out of date\nWaiting on: Worker — fresh review required\nNext step: The current code needs a fresh review and a new approval request.` : `**${entry.taskTitle}**\n${entry.decision.kind === "plan" ? "Plan approval · Planning" : "Code review · Review"}\nWaiting on: You\nNext step: Open this ${entry.decision.kind} and choose your decision.`; }),
          ...questions.map(entry => `**${entry.taskTitle}**\nQuestion · Waiting on you\n${entry.question.question}\nNext step: Open this question to answer.`),
          ...finalReady.map(row => `**${row.title}**\n${row.deliveryKind === "code" ? "Ready to publish" : "Ready to execute"}\n${row.deliveryKind === "code" ? "Review the code and comments in Paseo, then open the exact draft PR preview below." : "Open the prepared actions to review their environment and effects before authorizing them."}`),
          ...intervention.map(row => `**${row.title}**\nNeeds attention\n${row.pending ? "A request could not be confirmed. Check the task in Paseo before retrying." : row.mode === "paused" ? "This task is paused. Open it in Paseo when you are ready to resume." : "The task cannot continue automatically. Open it in Paseo to review the blocker."}\nDetails: ${row.message}`),
          ...recent.filter(entry => entry.decision.resume?.phase !== "sent").map(entry => { const receipt = decisionReceipt(entry, label, [...decisions.open, ...decisions.recent]); return `**${entry.taskTitle}**\n${receipt.context.status}\nNext: ${receipt.context.nextStep}`; }),
        ];
        return { text: `${label} · What needs me\n${selected.length + questions.length + finalReady.length + intervention.length} items needing attention${all ? " across this host" : " linked to this chat"}.\n\n${sections.join("\n\n") || "No linked questions or final actions are waiting. Older work may be unlinked; use All host work to inspect it without changing ownership."}\n\nNative tool permissions still appear in Paseo.`,
          context: { host: label, type: "summary", status: "Current saved requests", observedAt: new Date().toISOString(), evidence: "saved_record" },
          actions: [
            ...selected.map(entry => ({ label: `${rejectedFor(entry) ? "Outdated review" : entry.decision.kind === "plan" ? "Plan" : "Review"} · ${entry.taskTitle}`.slice(0, 60), command: `${entry.decision.kind} ${entry.decision.decisionId}` })),
            ...questions.map(entry => ({ label: `Question · ${entry.taskTitle}`.slice(0, 60), command: `question ${entry.question.questionId}` })),
            ...finalReady.map(row => ({ label: `${row.deliveryKind === "code" ? "Preview draft PR" : "Review actions"} · ${row.title}`.slice(0, 60), command: `${row.deliveryKind === "code" ? "draft pr" : "actions"} ${row.taskId}` })),
            ...recent.filter(entry => entry.decision.resume?.phase !== "sent").map(entry => ({ label: `Receipt · ${entry.taskTitle}`.slice(0, 60), command: `decision status ${entry.decision.decisionId}` })),
            ...(!all ? [{ label: "All host work (including unlinked)", command: "all needs" }] : []),
          ],
        };
      }
      const query = requested[2].trim().toLowerCase();
      const matching = decisions.open.filter(entry => entry.decision.kind === requested[1].toLowerCase() && (entry.decision.taskId.toLowerCase() === query || entry.decision.decisionId === query || entry.taskTitle.toLowerCase().includes(query)));
      if (matching.length !== 1) return { text: matching.length ? `Several tasks match. Use the exact task ID:\n${matching.map(entry => `${entry.taskTitle}: ${entry.decision.taskId}`).join("\n")}` : "No open decision matches that task. Use ‘needs’ or ‘all needs’ to see current requests." };
      const entry = matching[0];
      const d = entry.decision;
      if (details) return { text: `${chatReviewDetails(entry, label)}\n${chatLinks(target, d.workspaceId, d.agentId)}`, context: decisionContext(entry, label) };
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
      const offer = await offers.prepare({ owner, target, title: entry.taskTitle, kind: d.kind, context: decisionContext(entry, label), text: presentation, input: { ...ref, ...(d.candidate ? { expectedCandidate: d.candidate } : {}), changeFindingIds: entry.findings.filter(finding => finding.status === "open").map(finding => finding.findingId), ...(expectedPlanRevision ? { expectedPlanRevision } : {}) } });
      if (offer.state === "rejected") return { text: offer.receipt!, state: offer.state, context: offer.receiptContext };
      return { text: `${offer.text}\n\nProposal ${offer.id}\nReply: yes approve ${offer.id}\nOr: request changes: <what to change>\nOr: stop: <reason>\n${chatLinks(target, d.workspaceId, d.agentId)}`, offerId: offer.id, state: offer.state, proposalKind: offer.kind, context: offer.receiptContext ?? offer.context };
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
    const pipelines = (await createFleetStore().read()).pipelines.filter(row => row.coordinatorId === input.agentId && row.remoteServerId === target && (!["done", "stopped"].includes(row.mode) || Date.now() - Date.parse(row.updatedAt) < 86_400_000));
    const displayed = (await offers.forOwner(`${local}/${input.agentId}/${input.conversationId ?? "native"}`)).filter(offer => offer.target === target);
    if (!owned.length && !pipelines.length && !displayed.length) return { entries: [] };
    const decisions = listDecisions.output.parse(await invokeChatHost(target, listDecisions.name, { serverId: target }));
    const waiting = listWaiting.output.parse(await invokeChatHost(target, listWaiting.name, { serverId: target }));
    const scoped = (taskId: string, worker: string | null) => displayed.some(offer => offer.input.taskId === taskId) || pipelines.some(row => row.taskId === taskId) || owned.some(link => link.taskId === taskId || worker && link.remoteAgentId === worker);
    const concreteRequests = new Set([...decisions.open.map(entry => entry.decision.taskId), ...waiting.questions.filter(entry => entry.question.status === "open").map(entry => entry.question.taskId)]);
    const requests = [
      ...pipelines.filter(row => row.stage === "delivery" && row.mode === "ready" && !row.pending && row.deliveryKind !== "report" && !concreteRequests.has(row.taskId)).map(row => ({ id: `${target}:pipeline:${row.id}:draft:${row.lastDispatch}`, command: `${row.deliveryKind === "code" ? "draft PR" : "actions"} ${row.taskId}` })),
      ...decisions.open.filter(entry => scoped(entry.decision.taskId, entry.decision.agentId)).map(entry => ({ id: `${target}:${entry.decision.decisionId}:${entry.revision}`, command: `${entry.decision.kind} ${entry.decision.decisionId}` })),
      ...waiting.questions.filter(entry => entry.question.status === "open" && scoped(entry.question.taskId, entry.question.agentId)).map(entry => ({ id: `${target}:${entry.question.questionId}:${entry.question.askedAt}`, command: `question ${entry.question.questionId}` })),
    ];
    const entries: RpcOutput<typeof chatInbox>["entries"] = pipelines.filter(row => (row.mode !== "ready" || row.pending) && !((["blocked", "waiting"].includes(row.mode) || row.pending) && concreteRequests.has(row.taskId))).map(row => ({
      id: `pipeline:${row.id}:${row.mode}:${row.stage}:${row.lastDispatch}:${row.message}`,
      text: `${binding.label} · ${row.title}\n${row.mode === "done" ? row.deliveryKind === "report" ? "Your reviewed report is complete. Open it below to read the result." : row.deliveryKind === "actions" ? "The authorized actions have a saved completion receipt. Review the execution and verification results in Paseo." : "The task runner has completed its delivery work. Check the saved receipt for the published result; a merge or deployment is separate." : row.mode === "blocked" || row.pending ? "This task needs attention before it can continue. Open it in Paseo to inspect the issue." : row.mode === "paused" ? "This task is paused. Resume it in Paseo when you are ready." : ({ plan: "The planner is preparing the scope and checks.", "plan-review": "A second model is checking the plan.", execute: "The builder is carrying out the task.", validate: "The validator is running the planned checks.", review: "Independent reviewers are checking the result.", fix: "The builder is addressing the requested fixes.", approval: "A saved manual approval is waiting for you.", delivery: "The final result is being prepared." })[row.stage]}${row.mode === "blocked" || row.pending ? `\nDetails: ${row.message}` : ""}`,
      ...(row.mode === "done" && row.deliveryKind === "report" ? { actions: [{ label: "Read the completed report", command: `actions ${row.taskId}` }] } : {}),
      context: {
        host: binding.label, title: row.title, taskId: row.taskId,
        type: row.mode === "blocked" || row.mode === "paused" || row.pending ? "blocker" : row.mode === "done" ? "completion" : "update",
        stage: ({ plan: "Planning", "plan-review": "Independent plan check", execute: "Implementation", validate: "Validation", review: "Independent review", fix: "Fixing findings", approval: "Code approval", delivery: row.deliveryKind === "code" ? "Draft PR delivery" : "Reviewed result" })[row.stage],
        status: row.mode === "done" ? row.deliveryKind === "report" ? "Report complete" : row.deliveryKind === "actions" ? "Actions complete" : "Delivery complete" : row.pending ? "Request needs confirmation" : row.mode === "blocked" ? "Needs attention" : row.mode === "paused" ? "Paused" : "Work in progress",
        waitingOn: ["blocked", "paused"].includes(row.mode) || row.pending ? "You" : row.mode === "done" || row.mode === "stopped" ? "None" : "Worker",
        observedAt: row.updatedAt, evidence: "saved_record",
      },
    }));
    for (const entry of decisions.recent.filter((row, index, rows) => rows.findIndex(other => other.decision.taskId === row.decision.taskId) === index).filter(row => scoped(row.decision.taskId, row.decision.agentId) && Date.now() - Date.parse(row.decision.resume?.updatedAt ?? row.decision.resolvedAt ?? row.decision.requestedAt) < 86400000).slice(0, 10)) {
      const receipt = decisionReceipt(entry, binding.label, [...decisions.open, ...decisions.recent]);
      entries.push({ id: `${target}:receipt:${entry.decision.decisionId}:${entry.decision.resume?.phase ?? "saved"}:${receipt.context.actionNeeded}`, ...receipt });
    }
    for (const request of requests.slice(0, 30)) {
      const reply = await handle({ ...input, text: request.command }, { paseo });
      entries.push({ id: `${request.id}:${reply.offerId ?? "unavailable"}`, text: reply.text, ...(reply.context ? { context: reply.context } : {}), ...(reply.actions ? { actions: reply.actions } : {}), ...(reply.offerId ? { offerId: reply.offerId } : {}), ...(reply.proposalKind ? { proposalKind: reply.proposalKind } : {}) });
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
