import type { V2Task } from "./mission-control-v2-model";
import type { FleetSnapshot } from "../shared/fleet";

export const kanbanScreenId = "kanban";
export const kanbanLanes = [
  { id: "queue", title: "Up next", description: "Work waiting to start", icon: "ListOrdered" },
  { id: "progress", title: "Working", description: "Planning, building, testing and review", icon: "CircleDot" },
  { id: "attention", title: "Needs you", description: "Questions, final decisions or help to continue", icon: "MessageCircle" },
  { id: "done", title: "Done", description: "Completed work with saved results", icon: "CircleCheck" },
] as const;
export type KanbanLane = typeof kanbanLanes[number]["id"];
export type KanbanTab = "Next step" | "Plan" | "Code review" | "Decision" | "Evidence" | "Workers" | "Receipt" | "Delivery";
export type KanbanFocus = "All work" | "Needs you" | "Running";
export type KanbanTask = { row: V2Task; lane: KanbanLane; label: string; action: string; tab: KanbanTab; needsYou: boolean; running: number };

/** Lanes describe saved task workflow, never an agent's unread/finished-turn status. */
export function kanbanTask(row: V2Task): KanbanTask {
  const workers = row.workers.filter(agent => !agent.archivedAt);
  const running = workers.filter(agent => ["running", "initializing", "starting"].includes(agent.status)).length;
  const result = (lane: KanbanLane, label: string, action: string, tab: KanbanTab, needsYou = false): KanbanTask => ({ row, lane, label, action, tab, needsYou, running });
  if (row.state === "Unconfirmed" || row.limited) return result("attention", "Status unavailable", "Check connection and saved progress", "Workers");
  if (row.state === "Delivered") return result("done", "Delivery recorded", "Read delivery evidence", "Evidence");
  if (row.entry.problem) return result("attention", "Task record needs recovery", "Inspect blocker", "Evidence", true);
  if (workers.some(agent => agent.pendingPermissions > 0) || row.entry.questions.some(item => item.question.status === "open")) {
    return result("attention", "Worker needs an answer", "Read question or permission", "Decision", true);
  }
  if (row.staleReview) return result("attention", "Fresh review required", "Inspect changed revision", "Code review", true);
  const open = [...row.entry.decisions].filter(item => item.decision.status === "open")
    .sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt))[0];
  if (open?.decision.kind === "plan") return result("attention", "Plan approval requested", "Read plan and decide", "Plan", true);
  if (open?.decision.kind === "review") return result("attention", "Code review requested", "Review changes and checks", "Code review", true);
  const latest = [...row.entry.decisions].sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt))[0]?.decision;
  if (latest && latest.status !== "open" && latest.resume && latest.resume.phase !== "sent"
    && latest.taskId === row.entry.task.taskId && latest.runId === row.entry.run?.runId
    && latest.serverId === row.serverId && latest.workspaceId === row.entry.run.workspaceId) {
    const unconfirmed = latest.resume.phase === "sending";
    return result(unconfirmed ? "attention" : "progress", unconfirmed ? "Decision saved; delivery unconfirmed" : "Sending your decision to the worker", "Check delivery receipt", "Receipt", unconfirmed);
  }
  if (row.workflow.stage === "Delivery approval" && row.workflow.actor === "you") return result("attention", row.entry.pipeline?.deliveryKind === "actions" ? "Actions ready for your approval" : "Ready for your final review", row.entry.pipeline?.deliveryKind === "actions" ? "Review proposed actions" : "Review changes and delivery", "Delivery", true);
  if (row.state === "Blocked" || row.workflow.stage === "Blocked" || row.state === "Needs you") {
    return result("attention", "Needs clarification or recovery", "Resolve blocker in conversation", "Workers", true);
  }
  if (row.workflow.stage === "Your review") return result("attention", "Review request missing", "Inspect review evidence", "Code review", true);
  if ((row.workflow.stage === "Ready" && row.entry.pipeline?.stage !== "delivery") || (row.queue.length && !row.entry.run && !running)) return result("queue", "Waiting to start", "Read task details", "Workers");
  if (!row.entry.run && !running) return result("queue", "Waiting to start", "Read task details", "Evidence");
  const kind = row.entry.pipeline?.deliveryKind ?? row.entry.run?.deliveryKind ?? "code";
  if (["Intake", "Planning"].includes(row.workflow.stage)) return result("progress", "Preparing the plan", "Read planning progress", "Plan");
  if (row.workflow.stage === "Plan check") return result("progress", "Checking the plan", "Read the plan check", "Evidence");
  const label = row.workflow.stage === "Code review" ? kind === "code" ? "Reviewing the changes" : "Reviewing the prepared work" : row.workflow.stage === "Validating" ? "Running checks" : row.entry.pipeline?.stage === "delivery" ? kind === "actions" ? "Running authorized actions" : "Saving the completed report" : kind === "report" ? "Preparing the report" : kind === "actions" ? "Preparing proposed actions" : "Building the change";
  return result("progress", label, "See progress and checks", "Workers");
}

export function kanbanHasRequest(row: V2Task): boolean {
  return row.entry.decisions.some(item => item.decision.status === "open")
    || row.entry.questions.some(item => item.question.status === "open")
    || row.workers.some(worker => !worker.archivedAt && worker.pendingPermissions > 0);
}

/** Guidance comes from saved state, never from interpreting free-form handoff text as authority. */
export function kanbanGuidance(item: KanbanTask): { title: string; why: string; steps: string[]; after: string; action: string; tab: KanbanTab } {
  const { row, lane } = item;
  const make = (title: string, why: string, steps: string[], after: string, action: string, tab: KanbanTab) => ({ title, why, steps, after, action, tab });
  if (row.state === "Unconfirmed" || row.limited || row.entry.problem) return make(
    "Reconnect or recover the task before deciding", "This task cannot currently supply a fresh, complete record.",
    ["Check the host connection, then use Refresh task.", "If the record still fails, open its linked conversation and ask the worker to repair the task record."],
    "Decisions become available after a fresh, complete record is returned.", "Find recovery conversation", "Workers");
  if (item.tab === "Decision") return make("Answer the worker's request", "An open question or permission request is holding up this task.",
    ["Read the exact question or command and its context.", "Answer or choose the permitted action in the request below. Open the conversation if you need clarification."],
    "Check the saved reply or receipt; delivery to a worker does not mean the work is complete.", "Read and answer request", "Decision");
  if (row.staleReview) return make("Ask for a fresh review", "The saved review does not cover the current run or revision.",
    ["Inspect the changed revision in Code review.", "Ask the linked worker to validate and review the current candidate, then save a new review request."],
    "Review the new evidence before accepting code. The old decision cannot be reused.", "Inspect changed revision", "Code review");
  if (item.tab === "Receipt") return make("Check whether the worker received your decision", "Your decision is saved, but delivery needs follow-up.",
    ["Read the saved receipt and delivery status.", "If delivery is unconfirmed or failed, open the linked conversation and establish what actually ran before resuming."],
    "Continue from confirmed progress. Do not approve the same request again or blindly resend it.", "Read delivery receipt", "Receipt");
  if (item.needsYou && item.tab === "Plan" && item.row.entry.decisions.some(entry => entry.decision.kind === "plan" && entry.decision.status === "open")) return make("Review the plan, then approve or request changes", "The worker is waiting for your approval before implementing this scope.",
    ["Read the intended behavior, acceptance criteria and exclusions.", "Check the proposed changes, checks, risks and open questions. If the plan is unclear, ask for a plain-language revision.", "Approve the saved plan only when it matches what you want; otherwise request specific changes."],
    "Check the receipt. Approval permits this implementation scope; it does not publish anything.", "Read plan and decide", "Plan");
  if (item.needsYou && item.tab === "Code review" && !item.row.staleReview && item.row.entry.decisions.some(entry => entry.decision.kind === "review" && entry.decision.status === "open")) return make("Review the result, then accept or request fixes", "A code-review request is waiting for your decision.",
    ["Compare the change summary with the approved plan and acceptance criteria.", "Inspect the diff, actual validation results and unresolved findings. Missing or stale evidence must be refreshed.", "When the readiness checks allow it, use Your decision beside the report to accept the code or describe the fixes needed. Ask the reviewer to explain any change you cannot assess."],
    "Acceptance moves toward delivery preparation. Publishing, PR creation and merges require separate authorization.", "Review changes and checks", "Code review");
  if (lane === "progress" && ["Intake", "Planning", "Plan check"].includes(row.workflow.stage)) return make(item.label,
    "The task is being planned and checked. There is no decision waiting for you.", ["Read the saved plan or progress if you want an update.", "Open the conversation if requirements have changed or you have useful context."],
    row.entry.run?.workflowMode === "automatic" ? "A different model checks the plan before work starts. You will be asked if a question needs your answer." : "A saved plan request will tell you when your approval is needed.", "Read planning progress", "Evidence");
  if (lane === "queue") return make("Check priority with the coordinator", "The task is queued or ready for coordination; opening this card does not start it.",
    ["Check the recorded priority and blockers.", "Open the coordinator conversation to agree when to start or change the order."],
    "The coordinator checks eligibility and starts the appropriate phase; this board does not bypass that check.", "See queue and coordinator", "Workers");
  if (lane === "progress") return make(item.running ? "Monitor the worker; no decision is waiting" : "Check why the worker is waiting",
    item.label + ".",  ["Check the linked worker's latest activity and the saved checks.", item.running ? "Open its conversation only if you need to clarify scope or investigate a problem." : "Open the linked conversation to confirm whether work finished, failed or needs to resume."],
    "A saved question or review request will supply your next decision. A finished chat turn does not complete the task.", "See workers and progress", "Workers");
  if (item.needsYou && item.tab === "Delivery") return make("Review the finished work and proposed next action", "The work and checks are ready. The proposed publication or action still needs your permission.",
    ["Read the exact operation, repository, destination and evidence.", "If no delivery request is prepared, ask the owner to prepare one. Authorize only the specific action you intend."],
    "Check the resulting receipt and delivery evidence; approval alone does not confirm publication or deployment.", "Review delivery details", "Delivery");
  if (lane === "done") return make("Read the recorded outcome", "The recorded result confirms this work is complete.",
    ["Check delivery evidence and any remaining follow-up work.", "Do not infer a merge or deployment from the task label alone."],
    "No new decision is required unless you explicitly reopen or create follow-up work.", "Read outcome evidence", "Evidence");
  return make("Clarify the blocker in the linked conversation", "There is no open approval, question or permission request to answer here.",
    ["Read the saved handoff below; it may describe older work or an external dependency.", "Open the linked conversation, or find the owner in the owning workspace. Ask what is blocking this ticket now, who owns the next action, and whether a new approval request is needed."],
    "The owner should record a concrete next action or save a new request. Reading a handoff does not approve its proposed actions.", "Find the task conversation", "Workers");
}

export function filterKanban(tasks: KanbanTask[], host: string, project: string, search: string, focus: KanbanFocus): KanbanTask[] {
  const needle = search.trim().toLowerCase();
  return tasks.filter(item => (host === "all" || item.row.serverId === host)
    && (project === "all" || item.row.entry.task.projectId === project)
    && (focus !== "Needs you" || item.needsYou || item.row.state === "Unconfirmed" || item.row.limited)
    && (focus !== "Running" || item.running > 0)
    && (!needle || [item.row.hostLabel, item.row.entry.task.title, item.row.entry.task.ticket?.key, item.row.entry.task.taskId,
      item.row.entry.task.projectId, item.row.next, item.label, ...item.row.workers.map(agent => agent.name)].join(" ").toLowerCase().includes(needle)))
    .sort(kanbanOrder);
}

/** Done shows the most recently updated work first; the other lanes go by queue priority, then the longest waiting. */
function kanbanOrder(a: KanbanTask, b: KanbanTask): number {
  const done = Number(a.lane === "done") - Number(b.lane === "done");
  if (done) return done;
  if (a.lane === "done") return b.row.updatedAt.localeCompare(a.row.updatedAt) || a.row.key.localeCompare(b.row.key);
  return b.row.priority - a.row.priority || a.row.updatedAt.localeCompare(b.row.updatedAt) || a.row.key.localeCompare(b.row.key);
}

export function kanbanCounts(tasks: KanbanTask[]) {
  const confirmed = tasks.filter(item => item.row.state !== "Unconfirmed" && !item.row.limited);
  return {
    plans: confirmed.filter(item => item.needsYou && item.tab === "Plan" && item.row.entry.decisions.some(entry => entry.decision.kind === "plan" && entry.decision.status === "open")).length,
    reviews: confirmed.filter(item => item.needsYou && item.tab === "Code review" && !item.row.staleReview && item.row.entry.decisions.some(entry => entry.decision.kind === "review" && entry.decision.status === "open")).length,
    running: filterKanban(tasks, "all", "all", "", "Running").length,
    needsYou: filterKanban(tasks, "all", "all", "", "Needs you").length,
    unconfirmed: tasks.filter(item => item.row.state === "Unconfirmed").length,
  };
}

/** Sidebar activity is agent-based; decisions are task-based. Cached activity is never live activity. */
export function kanbanSidebarCounts(snapshot: FleetSnapshot | undefined, tasks: KanbanTask[], now: number, failed = false) {
  const unavailable = new Set<string>();
  const running = new Set<string>();
  const receivedAt = snapshot ? Date.parse(snapshot.observedAt) : NaN;
  for (const remote of snapshot?.hosts ?? []) {
    const host = remote.snapshot;
    const observedAt = host ? Date.parse(host.observedAt) : NaN;
    // Remote clocks can lead the installation clock. Bound that tolerance and
    // expire from the local receipt, never extend freshness into the future.
    const age = !Number.isFinite(receivedAt) || receivedAt > now || observedAt - receivedAt > 30_000 ? NaN : now - Math.min(observedAt, receivedAt);
    if (failed || remote.error || !host || !host.complete || !Number.isFinite(age) || age > 90_000 || age < 0) {
      unavailable.add(remote.serverId);
      continue;
    }
    for (const agent of host.agents) {
      if (!agent.archivedAt && agent.pendingPermissions === 0 && ["running", "initializing", "starting"].includes(agent.status)) {
        running.add(`${remote.serverId}:${agent.id}`);
      }
    }
  }
  // Coordinators live on the installation host, independently of their remote host connection.
  const age = snapshot ? now - Date.parse(snapshot.observedAt) : NaN;
  if (!failed && snapshot && Number.isFinite(age) && age >= 0 && age <= 90_000) {
    for (const { agent } of snapshot.coordinators) {
      if (!agent.archivedAt && agent.pendingPermissions === 0 && ["running", "initializing", "starting"].includes(agent.status)) running.add(`${snapshot.serverId}:${agent.id}`);
    }
  }
  const confirmed = tasks.filter(item => !failed && !unavailable.has(item.row.serverId) && item.row.state !== "Unconfirmed" && !item.row.limited);
  const plans = confirmed.filter(item => item.needsYou && item.tab === "Plan" && item.row.entry.decisions.some(entry => entry.decision.kind === "plan" && entry.decision.status === "open")).length;
  const reviews = confirmed.filter(item => item.needsYou && item.tab === "Code review" && !item.row.staleReview && item.row.entry.decisions.some(entry => entry.decision.kind === "review" && entry.decision.status === "open")).length;
  return {
    runningAgents: running.size,
    input: confirmed.filter(item => item.needsYou && item.tab !== "Plan" && item.tab !== "Code review").length,
    plans, reviews, ready: plans + reviews,
    unavailableHosts: unavailable.size,
  };
}

/** Controls require this task's fresh, complete host view; the existing server guards still recheck every action. */
export function kanbanCanAct(row: V2Task, online: boolean): boolean {
  return online && row.state !== "Unconfirmed" && !row.limited && !row.entry.problem;
}

export function kanbanLayout(width: number, compact: boolean) {
  const singleLane = compact || width < 700;
  return { singleLane, laneWidth: singleLane ? Math.max(240, width - 24) : Math.max(280, Math.min(350, (width - 60) / 4)) };
}
