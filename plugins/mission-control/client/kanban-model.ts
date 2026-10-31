import type { V2Task } from "./mission-control-v2-model";
import type { FleetSnapshot } from "../shared/fleet";

export const kanbanScreenId = "kanban";
export const kanbanLanes = [
  { id: "attention", title: "Needs attention", description: "Exceptions at any stage: answers, recovery or reconnect", icon: "TriangleAlert" },
  { id: "queue", title: "Up next", description: "Recorded queue and approved work to start", icon: "ListOrdered" },
  { id: "planning", title: "Planning", description: "Context and plan being prepared", icon: "Compass" },
  { id: "plan", title: "Plan approval", description: "Read the plan, then approve or request changes", icon: "NotebookPen" },
  { id: "progress", title: "In progress", description: "Building, validating or independent review", icon: "CircleDot" },
  { id: "review", title: "Code review", description: "Inspect changes and checks, then decide", icon: "Scan" },
  { id: "delivery", title: "Delivery", description: "Separate delivery approval or follow-up", icon: "GitPullRequest" },
  { id: "done", title: "Done", description: "Task explicitly recorded as delivered or closed", icon: "CircleCheck" },
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
  if (row.state === "Unconfirmed") return result("attention", "Host unconfirmed", "Inspect last-known task", "Workers");
  if (row.state === "Delivered") return result("done", "Delivery recorded", "Read delivery evidence", "Evidence");
  if (row.entry.problem) return result("attention", "Task record needs recovery", "Inspect blocker", "Evidence", true);
  if (row.staleReview) return result("attention", "Fresh review required", "Inspect changed revision", "Code review", true);
  if (workers.some(agent => agent.pendingPermissions > 0) || row.entry.questions.some(item => item.question.status === "open")) {
    return result("attention", "Worker needs an answer", "Read question or permission", "Decision", true);
  }
  const open = [...row.entry.decisions].filter(item => item.decision.status === "open")
    .sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt))[0];
  if (open?.decision.kind === "plan") return result("plan", "Waiting for plan approval", "Read plan", "Plan", true);
  if (open?.decision.kind === "review") return result("review", "Waiting for your code review", "Review changes & checks", "Code review", true);
  const latest = [...row.entry.decisions].sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt))[0]?.decision;
  if (latest && latest.status !== "open" && latest.resume && latest.resume.phase !== "sent"
    && latest.taskId === row.entry.task.taskId && latest.runId === row.entry.run?.runId
    && latest.serverId === row.serverId && latest.workspaceId === row.entry.run.workspaceId) {
    const unconfirmed = latest.resume.phase === "sending";
    return result("attention", unconfirmed ? "Decision saved; delivery unconfirmed" : "Decision saved; delivery pending", "Check delivery receipt", "Receipt", unconfirmed);
  }
  if (row.workflow.stage === "Delivery approval") return result("delivery", "Code accepted; delivery separate", "Inspect delivery", "Delivery", true);
  if (row.state === "Blocked" || row.workflow.stage === "Blocked" || row.state === "Needs you") {
    return result("attention", "Needs clarification or recovery", "Resolve blocker in conversation", "Workers", true);
  }
  if (row.workflow.stage === "Your review") return result("attention", "Review request missing", "Inspect review evidence", "Code review", true);
  if (row.workflow.stage === "Ready" || (row.queue.length && !row.entry.run && !running)) return result("queue", "Ready for coordinator", "Inspect task & queue", "Workers");
  if (["Intake", "Planning"].includes(row.workflow.stage)) return result("planning", running ? "Preparing plan" : "Planning; no active worker", "Check planning progress", "Plan");
  const label = row.workflow.stage === "Code review" ? "Independent reviewer working" : row.workflow.stage === "Validating" ? "Validating changes" : running ? "Implementing approved scope" : "Waiting on worker";
  return result("progress", label, "Inspect progress", "Workers");
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
  if (row.staleReview) return make("Ask for a fresh review", "The saved review does not cover the current run or revision.",
    ["Inspect the changed revision in Code review.", "Ask the linked worker to validate and review the current candidate, then save a new review request."],
    "Review the new evidence before accepting code. The old decision cannot be reused.", "Inspect changed revision", "Code review");
  if (item.tab === "Decision") return make("Answer the worker's request", "An open question or permission request is holding up this task.",
    ["Read the exact question or command and its context.", "Answer or choose the permitted action in the request below. Open the conversation if you need clarification."],
    "Check the saved reply or receipt; delivery to a worker does not mean the work is complete.", "Read and answer request", "Decision");
  if (item.tab === "Receipt") return make("Check whether the worker received your decision", "Your decision is saved, but delivery needs follow-up.",
    ["Read the saved receipt and delivery status.", "If delivery is unconfirmed or failed, open the linked conversation and establish what actually ran before resuming."],
    "Continue from confirmed progress. Do not approve the same request again or blindly resend it.", "Read delivery receipt", "Receipt");
  if (lane === "plan") return make("Review the plan, then approve or request changes", "The worker is waiting for your approval before implementing this scope.",
    ["Read the intended behavior, acceptance criteria and exclusions.", "Check the proposed changes, checks, risks and open questions. If the plan is unclear, ask for a plain-language revision.", "Approve the saved plan only when it matches what you want; otherwise request specific changes."],
    "Check the receipt. Approval permits this implementation scope; it does not publish anything.", "Read plan and decide", "Plan");
  if (lane === "review") return make("Review the result, then accept or request fixes", "A code-review request is waiting for your decision.",
    ["Compare the change summary with the approved plan and acceptance criteria.", "Inspect the diff, actual validation results and unresolved findings. Missing or stale evidence must be refreshed.", "When the readiness checks allow it, use Your decision beside the report to accept the code or describe the fixes needed. Ask the reviewer to explain any change you cannot assess."],
    "Acceptance moves toward delivery preparation. Publishing, PR creation and merges require separate authorization.", "Review changes and checks", "Code review");
  if (lane === "planning") return make(item.running ? "Wait for the plan, or clarify it in chat" : "Ask the owner to prepare the plan",
    "There is no open plan approval to answer yet.", ["Read any saved planning documents if you want to check progress.", item.running ? "Let the worker finish, or open its conversation to clarify requirements." : "Find the owner in the linked conversation or owning workspace. Ask for a readable, versioned plan and an approval request."],
    "Once a plan approval is saved, the task moves to Plan approval.", item.running ? "Read planning documents" : "Find the planning owner", item.running ? "Evidence" : "Workers");
  if (lane === "queue") return make("Check priority with the coordinator", "The task is queued or ready for coordination; opening this card does not start it.",
    ["Check the recorded priority and blockers.", "Open the coordinator conversation to agree when to start or change the order."],
    "The coordinator checks eligibility and starts the appropriate phase; this board does not bypass that check.", "See queue and coordinator", "Workers");
  if (lane === "progress") return make(item.running ? "Monitor the worker; no decision is waiting" : "Check why the worker is waiting",
    `Recorded phase: ${row.workflow.stage}.`, ["Check the linked worker's latest activity and the saved checks.", item.running ? "Open its conversation only if you need to clarify scope or investigate a problem." : "Open the linked conversation to confirm whether work finished, failed or needs to resume."],
    "A saved question or review request will supply your next decision. A finished chat turn does not complete the task.", "See workers and progress", "Workers");
  if (lane === "delivery") return make("Inspect the proposed delivery action", "Code acceptance and delivery authorization are separate.",
    ["Read the exact operation, repository, destination and evidence.", "If no delivery request is prepared, ask the owner to prepare one. Authorize only the specific action you intend."],
    "Check the resulting receipt and delivery evidence; approval alone does not confirm publication or deployment.", "Review delivery details", "Delivery");
  if (lane === "done") return make("Read the recorded outcome", "The task is explicitly recorded as delivered or closed.",
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
    && (focus !== "Needs you" || item.needsYou || item.row.state === "Unconfirmed")
    && (focus !== "Running" || item.running > 0)
    && (!needle || [item.row.hostLabel, item.row.entry.task.title, item.row.entry.task.ticket?.key, item.row.entry.task.taskId,
      item.row.entry.task.projectId, item.row.next, item.label, ...item.row.workers.map(agent => agent.name)].join(" ").toLowerCase().includes(needle)))
    .sort((a, b) => b.row.priority - a.row.priority || a.row.updatedAt.localeCompare(b.row.updatedAt) || a.row.key.localeCompare(b.row.key));
}

export function kanbanCounts(tasks: KanbanTask[]) {
  const confirmed = tasks.filter(item => item.row.state !== "Unconfirmed");
  return {
    plans: confirmed.filter(item => item.lane === "plan").length,
    reviews: confirmed.filter(item => item.lane === "review").length,
    running: confirmed.filter(item => item.running > 0 && item.lane !== "done").length,
    needsYou: confirmed.filter(item => item.needsYou).length,
    unconfirmed: tasks.filter(item => item.row.state === "Unconfirmed").length,
  };
}

/** Sidebar activity is agent-based; decisions are task-based. Cached activity is never live activity. */
export function kanbanSidebarCounts(snapshot: FleetSnapshot | undefined, tasks: KanbanTask[], now: number, failed = false) {
  const unavailable = new Set<string>();
  const running = new Set<string>();
  for (const remote of snapshot?.hosts ?? []) {
    const host = remote.snapshot;
    const age = host ? now - Date.parse(host.observedAt) : NaN;
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
  const plans = confirmed.filter(item => item.lane === "plan").length;
  const reviews = confirmed.filter(item => item.lane === "review").length;
  return {
    runningAgents: running.size,
    input: confirmed.filter(item => item.needsYou && item.lane !== "plan" && item.lane !== "review").length,
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
  return { singleLane, laneWidth: singleLane ? Math.max(240, width - 24) : Math.max(280, Math.min(350, (width - 48) / 3)) };
}
