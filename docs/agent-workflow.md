# Agent task bridge: operator guide

Use this flow in the application workspace assigned to the selected Mission Control task. The host vault owns task and run evidence; the application repository owns implementation. Obsidian is optional. The `/mission-task` command is registered and typechecked, but direct composer submission still needs a desktop smoke test; the pilot exercised the same task prompt and binding through a Paseo agent and the CLI.

## Start or resume from Mission Control

1. Select the owning host and application workspace, open **Tasks**, then open a task's details.
2. For a task without a run, choose an available provider and model and click **Start task**. The server validates the exact task assignment, project profile and checkout; it saves the run and agent identity before sending the task prompt.
3. **Open agent** takes you to the linked conversation while it is working or waiting for input. Normal provider permission prompts still apply. The launcher does not increase the agent's permissions.
4. Once the linked agent is idle, **Resume task** sends the latest task context to that same agent and run. It does not create a replacement agent. The prompt includes the exact IDs and the kit's skill paths, and tells the agent to reconcile its saved handoff before continuing.

The task dialog shows the recorded stage, outcome, next action, agent, and last launch receipt. A successful send is not a completed plan, test, review, or delivery. Launching does not change task status or approve a plan automatically. The existing workflow skills continue to govern planning, implementation, validation and independent review; plan and review decisions are answered in Attention's **Needs you** section (see below).

**Continue launch** recovers preparation interrupted before sending, reusing its reserved IDs. If sending may have succeeded but its response was lost, the launcher displays the uncertainty and will not resend automatically; inspect the linked agent before continuing there. Archived, missing, busy, or moved agents are not silently replaced. A task needs a task folder and one valid project profile before it can launch.

The launch journal lives in `.mission-control-launch.json` inside the task folder; evidence stays under `runs/<runId>`. A run is staged outside the visible run namespace and published only after its record is complete. Dispatch exclusion belongs to Paseo's single plugin worker. Paseo 0.9.1 reload waits for that worker to exit before starting its replacement; do not point independent daemons at the same writable vault.

Verified on personal: Start, browser reload, recorded waiting handoff, Resume with the same agent/run, and a completed handoff. Ten focused launcher tests and two CLI tests pass. The task dialog fits at 350 px without horizontal overflow. At an actual 390 × 844 browser viewport, the task opens in a scrolling bottom sheet with reachable 44 px Resume/Open agent actions and no horizontal overflow. Screenshot capture was unavailable, so this is DOM/layout verification; native device visual checks, remote hosts and the other provider integrations still need their own live checks.

## Open the exact task

In the assigned Paseo agent, invoke `/mission-task <taskId>`. Preserve the task, server, workspace, and agent IDs supplied by the command. Read the installed `check-environment` skill. Match `C:\dev-vault\Tasks\<taskId>\task.md` to its project profile under `C:\dev-vault\Projects`; use that profile's `kitRoot` and repository. Do not substitute IDs from another host or workspace.

For the personal pilot, the verified binding is:

- Task: `task_264d8373-7966-46ee-a208-659751e753bc`
- Server: `srv_yom2uemk7M7e`
- Workspace: `wks_40978f9035a2bbcd`
- Repository and kit: `C:\Code\development-flow`

PowerShell example:

```powershell
$kit = 'C:\Code\development-flow'
$binding = @('--task', 'task_264d8373-7966-46ee-a208-659751e753bc',
  '--server', 'srv_yom2uemk7M7e', '--workspace', 'wks_40978f9035a2bbcd',
  '--cwd', 'C:\Code\development-flow')
node "$kit\scripts\dev-flow.mjs" context @binding
```

`context` checks host, assignment, profile, repository and Git state, then returns the latest run and handoff. Reconcile saved evidence with the current checkout. A null Git HEAD means the branch has no commit; dirty files must be reported. A saved status is not approval or validation.

If there is no run, start one with the actual agent ID supplied by Paseo:

```powershell
# Set $agentId to the exact ID from /mission-task; never invent it.
node "$kit\scripts\dev-flow.mjs" start @binding --agent $agentId
```

Save the returned run ID. Resume that run for the same attempt; `start` creates a new run. The CLI can record a null agent ID when no identity is available, but that does not prove that a Paseo agent was linked.

## Agent-managed workspace labels

Verified on personal with Paseo 0.10.2: an agent can create, assign and remove native workspace labels using the exported `DaemonClient` from `@getpaseo/client/internal/daemon-client`. This is the same internal API the native app uses; it is separate from agent labels and is not exposed by the public `PaseoApi`, workspace CLI, or mounted MCP catalog. Keep this version-sensitive adapter isolated and capability-check it before use. Never write Paseo's private label files.

The methods are `listWorkspaceLabels()`, `setWorkspaceLabel({ workspaceId, label: { name, color }, assigned: true | false })`, `updateWorkspaceLabel(...)`, `inspectWorkspaceLabelDelete({ name })`, and `deleteWorkspaceLabel({ name })`. Assignment creates a missing definition on that host. Removing an assignment does not delete the definition. Do not rename, recolor or delete a shared definition as part of a task transition.

Before changing a label, run the exact task's `dev-flow.mjs context` binding. Connect to the owning daemon, verify `getDaemonStatus().serverId`, then use `createPaseoApi(client).workspaces.ref(workspaceId).refresh()` to verify the live project ID and workspace directory against that binding. Read the catalog and assignments; reuse an existing definition's name and color. After each change, refresh the workspace and verify the assignment and all unrelated labels. A timed-out write is unconfirmed: read current state before retrying. Always close the client. Record the verified old/new labels, host/workspace identity and reason in the existing stage evidence or handoff.

The kit exposes the verified route through `dev-flow.mjs workspace-label`, reusing the exact task binding above:

```powershell
node "$kit\scripts\dev-flow.mjs" workspace-label @binding --action get
# Explicit coordinator/user instruction, including shared workspaces:
node "$kit\scripts\dev-flow.mjs" workspace-label @binding --action assign --label 'Ready'
node "$kit\scripts\dev-flow.mjs" workspace-label @binding --action remove --label 'Ready'
# Task-owned workspace only; refuses another active linked task:
node "$kit\scripts\dev-flow.mjs" workspace-label @binding --action status --label 'In Progress' --reason 'Approved implementation is running.'
```

`assign` creates a missing definition; `remove` only detaches it. `status` replaces the previously observed workflow status labels and preserves unrelated tags. It requires a reason, checks recorded readiness/blocker/review/delivery conditions, and rechecks linked tasks after the change. Setting Done also requires a complete live agent roster without other working or permission-waiting agents; pass the exact current `--agent` ID (or use `PASEO_AGENT_ID`) to exclude the coordinator making the final update. `get` returns the owning catalog and linked task statuses so the coordinator can assess shared work. Preserve user-selected labels regardless of what the command can technically do.

The default endpoint is the local `ws://127.0.0.1:6767/ws`; use `--url` only for the verified owning WebSocket endpoint. This helper does not parse relay pairing links or configure authentication; an authenticated/remote endpoint it cannot reach fails visibly. It never falls back to another daemon. The kit's installed Mission Control dependency supplies the client; no private store edits or global package installation are needed. Save the JSON receipt in the existing run evidence before reporting success.

Exactly one coordinator owns a workspace's workflow label. In a workspace dedicated to one task, that coordinator uses the checkpoints below. In a shared workspace, an individual task never replaces the workspace's overall label: consider every linked active task and working agent, or retain the label and report the task-specific state in its existing records. Preserve unrelated tags and user-selected labels; a pre-existing label of unknown provenance changes only on an explicit user/coordinator instruction. Task status, decisions, evidence and delivery authorization remain authoritative.

| Workflow checkpoint | Workspace label, when the workspace is task-owned |
|---|---|
| Intake or plan awaiting approval | Retain the current label; record the open question/decision. Waiting is not a blocker. |
| Approved scope, ready to start | Ready |
| Active planning, implementation, validation or fixes | In Progress |
| Candidate in independent review or awaiting its review decision | Review |
| Explicit recorded inability to continue | Blocked, with the actual reason |
| User explicitly pauses work | Paused |
| Required delivery and verification recorded complete, task delivered/closed, no other active task or agent | Done |
| Handoff or resume | Reconcile current records and live work; a completed handoff/stage never proves the task is Done. |

A label API failure is a labeling failure, not proof that task implementation is blocked. Surface the failure, retain the existing label, and continue otherwise authorized work. Do not claim completion from an agent message without read-back evidence. Native desktop/mobile visual validation remains separate from API verification.

## Naming checkpoints

25 September 2026 · Shared workflow policy. The versioned `intake-task`, `plan-task`, and `write-handoff` skills now prompt naming reviews at their checkpoints. They record suggestions and preserve user-chosen or unknown-provenance names; they do not run automatic renames. Workspace/agent renaming is available through Paseo. Mission Control's Review names, persistent locks, and undo controls are planned. The [product specification](mission-control-plugin-spec.md#naming-process-and-controls) owns the UI and automation requirements.

Evaluate names at meaningful workflow checkpoints using the task brief, accepted plan, explicit assignments, and latest scoped handoff. Reuse the agent doing the work; a separate naming service is unnecessary for the first version.

| Checkpoint | Intended skill/owner | Naming action |
|---|---|---|
| Intake | `intake-task`; workspace coordinator | Propose useful provisional workspace and agent names from the task brief. Preserve names explicitly chosen by the user. |
| Plan ready | `plan-task`; workspace coordinator and assigned agents | Review the clarified goal and each agent's responsibility. This is the main checkpoint for refining generated names. |
| Agent or terminal creation | Creating agent/coordinator | Assign a short purpose-specific name immediately, such as `Task Bridge Review`, `Dev Server`, or `Tests`. |
| Material scope change or handoff | `write-handoff`; current owner | Compare the existing name with the actual work. Suggest an update when the name no longer fits; leave accurate names unchanged. |

Naming rules:

- Workspace names describe the overall goal and stay stable across the workspace's individual tasks. Exactly one designated coordinator owns changes to the workspace title.
- For a workspace related to a Jira issue or Azure DevOps work item, put its exact issue key/work-item number before the title: `APP-123 · Fix Login Timeout` or `12345 · Update Export Format`. Use linked ticket metadata or a ticket explicitly associated with the workspace in its name or user prompts; never invent a number or substitute a Mission Control task ID. If several tickets clearly define the workspace's scope, list their distinct keys/numbers before the title. The ticket prefix does not count toward the 2–5 descriptive words and is not added to agent names.
- Agent names describe their responsibility in 2–5 words. Do not prefix them with the workspace name or `Mission Control`; workers may update their own session names within the naming policy.
- Terminal names describe the session/script purpose. Keep a useful name across ordinary commands. Verify the supported naming API before updating an existing terminal.
- Treat a name the user chose or explicitly accepted as locked. It changes only after an explicit unlock or rename request. For a pre-existing name with unknown provenance, suggest a replacement instead of applying it automatically.
- Automatic refinement is a future opt-in capability restricted to explicitly managed, unlocked generated names at the planning checkpoint. Re-read the current title before applying a proposed change; if it changed since evaluation, refresh the suggestion.
- Address every rename by its exact host and resource ID. Preserve task/run bindings, repository paths, and branches. Record an applied rename's resource ID, old/new title, reason, and owner in the existing stage evidence or handoff; a rename creates no new workflow stage.

For a user-requested batch review, collect proposed names in a Current → Suggested list with a short reason, let the user edit or select them, then apply through supported Paseo actions and verify the result. An explicit request to rename already authorizes that work; this procedure does not require a second approval for the same scope. The planned UI will expose Apply selected, per-item lock state, and undo without overwriting a subsequent rename.

Workspace **Ready / In Progress / Review / Blocked / Paused / Done** labels provide the status overview described in [workspace labels and status](mission-control-plugin-spec.md#workspace-labels-and-status). Keep those states out of tab titles. Labels summarize the workspace; task/run records continue to own workflow progress, decisions, and evidence. Naming or labeling an item does not approve a plan, complete a review, or authorize delivery.

## Plan, execute, and record evidence

Use `plan-task` to save `plan.md` beside `task.md`: scope, intended behavior, files, checks, non-goals, and the plan decision. Retain explicit authorization within its scope. Use `execute-task` for the approved work, keeping one writer per file. Use `validate-changes` for actual check results.

Record each stage with a UTF-8 JSON file:

```json
{
  "stage": "execute",
  "outcome": "completed",
  "summary": "Describe only work actually completed.",
  "nextAction": "Run the selected validation commands.",
  "evidence": ["Full path to the relevant plan or artifact"]
}
```

```powershell
node "$kit\scripts\dev-flow.mjs" record @binding --run $runId --input $inputFile
```

Use the exact returned run ID and the path of your own temporary JSON input; remove only that input after a successful record. Stages are `intake`, `plan`, `execute`, `validate`, `review`, `fix`, `delivery`, and `handoff`. Outcomes are `in_progress`, `completed`, `blocked`, and `waiting`. Completed validation and review require evidence. Each record captures current Git state, appends an event under `runs/<runId>/events`, and updates `run.md`. CLI success records an observation; it does not run tests or independently establish their result.

## Needs you: plan and review decisions

Agents ask the user for a decision instead of asking in chat. `request-decision` saves `runs/<runId>/decisions/<decisionId>.md` and, for reviews, adds findings to `runs/<runId>/findings.json`; it records the stage as `waiting`. Only one decision per run can be open at a time.

Each request carries `plain` fields for a busy product owner alongside the technical `summary`: what was built or planned, what the review found, and a recommendation (`accept`, `fix` or `stop`) with a one-line reason. Each finding adds a plain description, its impact if skipped, and whether to `fix` or `skip` it. The CLI checks lengths, refuses internal IDs, commit hashes and file paths in plain text, and warns (in its output and on stderr) about file, code and tool names. `dev-flow.mjs help` shows the input. Older decisions without plain fields still show, with a generic line.

```powershell
node "$kit\scripts\dev-flow.mjs" request-decision @binding --run $runId --input $inputFile
node "$kit\scripts\dev-flow.mjs" decision @binding --run $runId --decision $decisionId
node "$kit\scripts\dev-flow.mjs" finding @binding --run $runId --finding $findingId --status awaiting_verification --evidence "What changed"
```

The user answers in Mission Control → Attention → **Needs you** (or the workspace's Mission panel). The card shows the plain sentences, the recommendation, and buttons named for what they do: **Accept** (**Accept, skipping N** when open findings would be skipped), **Fix N issues first** and **Stop**; for plans **Approve plan**, **Change the plan** and **Stop**. **More** lists what was built, the fixes a review verified, each open finding with its own **Fix now** / **Skip** choice (starting on the agent's recommendation), what each button does, and the technical details. Stopping, skipping findings, and plan changes need a note; skipping and stopping start with an editable default ("Skipped for now; track as a follow-up."). An answer never sends a note the user hasn't seen: unless the open note box already shows it, the card first shows the exact action and editable note. Mission Control saves the decision first, then sends it to the run's agent only when that agent is idle. A busy agent leaves the decision **Saved, not sent** with a **Send to agent** retry. A send error is shown as unconfirmed and is never resent automatically.

Finding states: `open` → (user) `submitted` or `dismissed` → (fixer) `awaiting_verification` → (fresh review evidence) `resolved`, or back to `submitted`. Agents cannot move findings out of `open`, and `resolved` requires evidence. Approving a review is refused while earlier findings still await a fix or verification. A decision grants no commit, push, merge, or deployment permission.

## Waiting for you: ordinary questions

When an agent stops to ask the user something that isn't a plan or review decision, it first records the question with `ask`. Start task's prompt tells task agents to do this. The input is `{ "question": "...", "plain": { "status": "<where things stand, at most 3 sentences>", "need": "<what you need, one sentence>", "recommendation": "<optional>" } }`.
- The plain fields follow the same rules as a decision's; longer text is rejected.
- `ask` saves `runs/<runId>/questions/<questionId>.md`, marks the run's earlier open question `replaced`, and records a `waiting` event. `context` returns the latest run's questions.

```powershell
node "$kit\scripts\dev-flow.mjs" ask @binding --run $runId --input $inputFile
```

Attention shows the question as a **Waiting for you** card with a **Reply** box. Reply sends the text to the agent that asked, which must be idle in its workspace, then records it as the answer. The card also clears when the agent gets a message in its chat after the question.

Attention also shows a **Waiting for you** card for any agent Paseo flags with an error, on every online host. The card says what failed, from Paseo's last error, and its Reply goes straight to that agent on its host.

Agents Paseo flags only as finished are not listed. Paseo's attention reasons are only finished, error and permission, so it can't tell a question from a normal finish; a recorded `ask` is the only reliable signal.

Every Needs you card uses the same layout:
- The task line: the task's number and title (from the agent's task label), or the agent's title, then host / project / workspace.
- Where it's at: the agent's own summary. Without one, a trimmed quote of its latest chat message, marked as such, but only for a live agent. Reading a chat makes Paseo wake an agent that has stopped, so Attention never reads a closed, errored or archived agent's chat by itself: error cards use Paseo's error message, and the chat is read only when you open **Conversation**.
- Needs from you, and the agent's recommendation when it gave one.
- The answer buttons.
- A collapsed **Conversation** with the last few messages and steps, and a small **Open agent →** link.

Permission cards say what the agent **Wants to** do in plain words. **Details** keeps the full command or input.

## Mission panel and permission prompts

Each workspace with active agents has a **Mission** button in its header. It reads **N need you** while permission prompts or plan/review decisions are waiting, and opens the Mission tab in Paseo's right panel: permission prompts with the agent's own choices, open decisions, active tasks with their stage and next action, review progress, and the workspace's agents. `/mission` opens it from a chat. Mission Control's Attention tab also lists pending permission prompts, because Paseo's own attention flag can stay unset while a prompt waits.

## One worktree per task

**Start task** offers **Work in its own worktree**, on by default when the project is a Git repository with at least one commit. Mission Control then:

1. Creates a `task/<id>-<title>` branch off the source workspace's current branch in a Paseo-managed worktree, registered as its own workspace. An interrupted start finds the same branch and worktree again instead of creating a second one.
2. Adds that workspace to the task's assignments (the source workspace stays, so the task is visible in both) and records `worktree` (workspace, branch, branch point, source workspace) in `task.md`.
3. Starts the agent in the worktree. `dev-flow.mjs` accepts linked worktrees of the profile repository, and every later Start/Resume uses the worktree.
4. Sets the worktree's Review to **everything since this task branched**, so the task's commits stay reviewable.

**Branch names.** **Settings → Plugins → Mission Control → Branch names** sets a template for the host and optional overrides per project, for example `{ticket}-{slug}` (ABC-123-add-login-retry) or `{type}/{ticket}-{slug}`. The tokens are:

- `{ticket}`: the task's ticket key.
- `{slug}`: a short description from the ticket's title.
- `{type}`: `feature` or `bugfix`. It comes from the ticket's work item type when the Morning check recorded one; otherwise you choose it in Start task.
- `{id}`: the short task ID.

Start task shows the exact branch before creating it. Mission Control checks the name against Git's rules. It refuses a branch that another task already records, and a templated name that already exists in the repository, so a task never takes over a branch you made yourself. Without a template, or for a task without a ticket, the branch stays `task/<id>-<title>`.

Uncommitted changes in the source workspace are not copied into the worktree. Merging the task branch back is a delivery step that needs explicit authorization. Archiving the worktree workspace removes its folder; the branch remains until it is deleted.

## Morning check

The Morning check is manual for now: you start it. A daily schedule comes later.

1. In Mission Control, open a workspace on this host whose project has a Development Flow profile. At the bottom of the workspace page, **Morning check** picks a provider (its default model) and starts a `Morning check` agent in that workspace with the [`morning-check`](../skills/morning-check/SKILL.md) skill. **Use test fixture** makes the agent read `scripts/fixtures/morning-check-items.json` instead of Jira or Azure DevOps. A new check is refused while the previous Morning check agent is still working (starting, running, mid-turn, or waiting on a permission prompt); one that ended in an error or was closed doesn't block it. Starts are serialized, so two devices pressing Run together start one agent.
2. The agent reads your current-sprint items with the Jira or Azure DevOps MCP tools its session has. It only reads: it never changes the tracker. Without those tools it says so and still reviews the Mission Control side.
3. It runs `node <kitRoot>\scripts\morning-check.mjs report …`, which writes the report to `C:\dev-vault\Daily\`.
4. The section shows the latest report. Tick the items to import and click **Import selected**. Each becomes an Inbox task in that workspace with the ticket, the title `KEY · title`, and the item's acceptance criteria (or description), cut to the 4000-character limit and followed by the ticket link. An item that already has a task is skipped, so importing twice creates no duplicates. Task details show the ticket and an **Open ticket** link.

Each host runs its own Morning check through its own Mission Control installation and vault. For another host, open Mission Control there.

### Tasks with an external ticket

A task imported from a tracker has one more `task.md` frontmatter line. Tasks without it stay valid.

```text
ticket: {"system":"jira","key":"ABC-123","url":"https://example.atlassian.net/browse/ABC-123"}
```

`system` is `jira` or `azure-devops`; `key` is the Jira issue key or the Azure DevOps work item ID; `url` is an http(s) link. A task matches a tracker item when both `system` and `key` are equal, ignoring the key's case. `source` stays `"manual"`.

### Morning check report

`Daily/morning-<YYYY-MM-DD>-<HHMMSS>.md`, named by the host's local time. A second report in the same second gets `-2`, `-3`, …. Reports are never overwritten. Like other vault records, the frontmatter holds one JSON value per line:

| Field | Meaning |
|---|---|
| `schemaVersion` | `1` |
| `reportId` | The file name without `.md` |
| `hostId`, `serverId` | From the vault's `host.json` |
| `agentId` | The agent that ran the check, or `null` |
| `createdAt` | When the report was written (ISO, UTC) |
| `since` | Start of the review window: by default the start of the previous local day; `--since` overrides it |
| `tracker` | `{"mode":"read","systems":["jira"]}`; `mode` is `read`, `unavailable` or `fixture`, and `systems` lists the trackers the items came from |
| `items` | The current-sprint items read: `system`, `key`, `url`, `title`, `description`, `acceptanceCriteria`, `status`, `sprint`, and `taskIds` (tasks that already carried the ticket when the report was written) |
| `review` | Counts: `missing`, `imported`, `handoffs`, `openDecisions`, `blocked`, `idle`, `unreadable` |

The Markdown body has these sections, each with its count:

- **Tracker:** what was read (live tracker, test fixture, or no tracker tools).
- **Not in Mission Control:** items no task carries yet, as `- [ ] [KEY](url) title · system · status · sprint`. Omitted when no tracker was read.
- **Already in Mission Control:** items with a task, linked to it. Omitted when no tracker was read.
- **Yesterday's handoffs:** `handoff.md` records written since `since`, with the run's stage and outcome and the handoff's first line.
- **Needs you:** open plan and review decisions.
- **Blocked:** open tasks whose status is Blocked or whose latest run is blocked.
- **Idle:** In progress tasks, not blocked or waiting on a decision, with no task or run activity for 24 hours.
- **Agent notes:** the agent's notes file, when given.
- **Records that could not be read:** task records the script skipped, when any.

Mission Control compares the report's items with the host's tasks again when it shows the report, so items imported after the report was written appear as imported.

## Validate the pilot

From `C:\Code\development-flow`, run the CLI suite and the plugin's configured typecheck:

```powershell
node --test scripts/dev-flow.test.mjs
node --test scripts/morning-check.test.mjs
node --test plugins/mission-control/server/tasks.concurrent.test.mjs
npm --prefix plugins/mission-control run typecheck
```

Save command output, exit codes, timestamps, Git state, and hashes of the files examined in the task evidence. If another writer changes CLI/plugin files during validation, label the result as an observation of that changing checkout and refresh checks after it stabilizes. A passing typecheck does not establish UI behavior.

In Mission Control, select the same host, workspace and task. Confirm the latest run ID, stage, outcome and next action agree with the CLI context and vault record. Verify the guide/plan and run evidence can be opened through the supported task document views. Record what was actually observed; a readable CLI context alone does not prove UI visibility.

## Review and resume

Stop application edits while an independent reviewer examines the candidate and validation evidence. Use `review-changes` with the acceptance criteria, plan, exact candidate state and intended scope. On a branch without commits, explicitly select workspace review and list unrelated files excluded from the review. Do not mark review completed before the reviewer returns evidence. Material fixes need fresh affected validation and review.

Use `write-handoff` with stage `handoff` and an honest outcome. Recording that stage writes `handoff.md` in the run folder. Include remaining actions, approvals, checks, review status, concurrent changes, and blockers. A waiting review is not task completion. On resume, run `context` again and reconcile the handoff with current Git and task assignment.

For a binding error, correct the selected host/workspace/profile before writing evidence. For missing tools or failed checks, record the actual blocker. For Git ownership errors, use the repository owner's approved execution context rather than changing global trust settings. Do not commit, stash, or change task assignment just to make this proof appear complete.
