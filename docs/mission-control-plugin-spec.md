# Mission Control for Paseo: product and build specification

23 September 2026 · Proposed design and first implementation slice

This document updates the [start-here roadmap](../development-flow-start-here.md). The two [UI concepts](mission-control/mockups/fleet-overview.png) and [task-detail concept](mission-control/mockups/task-detail.png) are design references, not screenshots of an implemented plugin.

## 1. Job and boundaries

Mission Control answers four questions without making you inspect every open workspace: **Where is work happening? Who owns it? What needs a decision? What can be delivered or cleaned up?** It is the Paseo-facing view of the development kit. The individual skills, project profiles, Host Brain vaults, tracker adapters, review process, and morning/nightly runs still do the underlying work.

Start by shipping a usable navigation plugin against the installed Paseo version. Add task and delivery records before showing confident workflow claims. A sidebar entry and a full Mission Control surface are enough to test the layout early; changing Paseo's built-in workspace sidebar hierarchy or enumerating every native tab may require a core Paseo change. Verify the SDK on the actual daemon and app before promising either behavior.

The initial plugin is read-only against workspaces and agents. It may remember UI preferences. It must never infer permission to create agents, send prompts, write tracker data, merge, archive an agent, archive a workspace, or remove a worktree from a visible button. Later mutations follow the kit's scoped approval rules.

## 2. Where each part lives

| Paseo location | Mission Control use | First release |
|---|---|---|
| Sidebar item | Persistent **Mission Control** entry with an attention count when supported; opens the full surface | Entry only; defer count until trustworthy |
| Full surface | Host → project → workspace navigator, agent tree, attention and task queues, right-hand inspector | Two-host navigator, roster, quick open, connection states |
| Workspace / Explorer panel | Workspace brief: linked tasks, agents, last known activity, delivery and cleanup evidence | Basic agents and activity; richer brief later |
| Agent composer | `Mission` pill to inspect assignment or structured pending work; `/task`, `/mission`, `/status` shortcuts | Add after record commands exist |
| Agent timeline | Small linked decision, task, and delivery events with a route to the full record | Later |

Desktop layout: a narrow host/workspace tree on the left, a center view with **Now / Missions / Tasks / Delivery / Cleanup**, and a detail inspector on the right. Keep the tree useful with eight hosts, filtering, collapsed projects, pinning, and count badges that identify their scope. On a small screen, use a host picker and a single primary list; show the detail as a sheet or panel. Use Paseo theme tokens and React Native components for the client.

A later Mission Control settings screen should follow Agent Monitor's plugin settings pattern. Start with useful UI preferences such as default filter, host/project grouping, density, sorting, pinned items, and which status details appear. Store these as host-scoped presentation preferences; task and decision truth stays in the Host Brain vault. Add controls as the corresponding views become real, rather than exposing an unused settings matrix.

The full surface groups workspaces by **host first**, then project. Each workspace shows agents/terminals when the SDK exposes them, and its related tasks. The native Paseo tabs can still hold agents, terminals, files, and browsers. Mission Control should offer reliable open actions for supported items; native tab inventory and reordering are separate capabilities to investigate, not assumed plugin APIs.

### View and personalization roadmap

Keep the present host-first workspace list as the default view. Add a **Kanban view** once task lifecycle records can supply real columns and counts; switching views must preserve the selected host, project, and task filters. On both views, let the user set host order and project order manually, hide individual hosts and projects, and temporarily show only online hosts. Use stable IDs for saved order and visibility so renames do not reset them. Hidden items should remain recoverable in settings and should not silently disappear from attention counts.

Make **Attention** a cross-host triage view with host, project, workspace, agent, reason, and updated/flagged time visible on each card. Search and filter by host and project; prioritize permission requests and errors without claiming that every Paseo attention flag is a workflow approval. Keep offline entries marked with their last observation. Open the underlying agent for the actual prompt or error.

Agent rows should identify Codex, Claude, OpenCode, and other providers with a compact provider mark or icon. Show the agent's work title, provider/model, status, and last update directly. Show creation time and other available timestamps in the detail view. Add role (orchestrator, builder, test, reviewer) and priority only when an explicit assignment record or label supplies them; otherwise say they are unassigned. A future hover detail on desktop may supplement this, but essential state must remain readable on touch screens.

Add a Mission Control settings screen under Paseo's plugin settings. Start with host emoji, manual host/project order, hidden hosts/projects, online-only default, and preferred view. Store these presentation preferences in Paseo's host-scoped settings document; the personal host owns this dashboard's preferences. Keep task and decision records in the vault. Later evaluate an explicit install/update action for Mission Control on remote hosts from the main host, with host selection, visible version/status, and confirmation of the source before installing. Remote installation is a separate capability from reading another host's roster.

For mobile, use a short horizontal host selector, one vertical page scroll, generous touch targets, and task actions near the selected workspace. Test at phone width and with many hosts/projects, not only a narrow desktop window. The task editor must be reachable from Mission Control even if Paseo keeps contributed workspace panels behind the Command Center.

### Naming process and controls

25 September 2026 · Naming checkpoints are in `intake-task`, `plan-task`, and `write-handoff`. The first **Review names** dialog is built: it renames the workspace through the public `workspaces.ref(id).setTitle` API on any online host, re-reads the current title before every apply or undo so a newer rename is never overwritten, and flags names over five words or agent names that repeat the workspace name. Paseo 0.9.x has no public plugin API for renaming agents or terminals (only the CLI and internal daemon client), so the dialog lists agents with **Open** links and leaves renaming to their tab or the agent itself.

26 September 2026 · Name suggestions are built for workspaces and agents. **Review names** (a workspace and its agents) and **Rename all** (every workspace in the current list) show Current and an editable Suggested field with a checkbox and a one-line reason. **Suggest** / **Suggest all** fill the fields; only checked, changed rows are renamed by **Apply selected**, each behind a stale-name guard (a name changed since the dialog showed it is never overwritten), with one **Undo** for the last apply. Closing the dialog or **Stop** ends a bulk run after its current batch. A suggestion runs one short-lived Paseo agent per batch of about eight names on the smallest available model (Claude Haiku, else GPT-6-Luna on low; never a larger fallback) with a JSON `outputSchema`, in the first workspace of the batch, then archives it. The plugin's prompt holds each workspace's ID, current title, project name, and linked Mission Control task titles and statuses (this installation's host only), plus, for the six most recently updated agents and every agent being renamed, its ID, title and its first three and last two user prompts (read from the start and end of its timeline), each cut to 600 characters. The prompt contains no assistant replies or tool output. Because the naming agent is an ordinary provider session in that workspace, its provider may still load the project's instruction files and could read files if it ignored its instruction not to use tools.

Agent renaming relies on an **internal Paseo API**. `PaseoApi` 0.9.1 has no agent rename, so the Mission Control server's `agents.rename` RPC opens a short-lived `DaemonClient` from `@getpaseo/client/internal/daemon-client` against the local daemon's `/ws` endpoint (address from `daemon.listen` in Paseo's `config.json`, client type `cli`, the same approach as the paseo-auto-pin plugin) and calls `updateAgent(agentId, { name })`, the call behind MCP `update_agent`. It re-reads the agent's current name first and refuses a stale rename. It reaches only the daemon on the host running this Mission Control, so agents on other hosts keep their **Open** links. Paseo cannot clear an agent title, so undoing the rename of an untitled agent writes back its displayed fallback name (for example `claude agent`). A Paseo update that changes this internal module can break agent renaming without a type error. Locks remain planned; see the [naming checkpoints](agent-workflow.md#naming-checkpoints).

Names should improve as the task becomes clear. Review them at intake, when the plan is ready, and at a scope change or handoff when the existing name no longer fits. Name agents and terminals for their assigned purpose when creating them. Use the agent already working on the task to evaluate its name at these checkpoints; avoid a separate background naming service for the first implementation.

- **Workspace:** the overall goal, kept stable across its agents and tasks; examples: `Mission Control`, `Invoice Rounding Fix`.
- **Agent:** its current responsibility; examples: `Label Filters`, `Task Bridge Review`, `Mobile Layout`. Prefer 2–5 words. Do not repeat the workspace name or prefix tabs with `Mission Control`.
- **Terminal:** the session or script purpose; examples: `Dev Server`, `Tests`, `Build`, `Shell`. Do not rename a terminal after every command.

One designated coordinator owns workspace naming. Workers may name their own agent sessions; terminal naming belongs to the session creator or coordinator. Use stable resource IDs for every action. A display-name change must preserve task assignments, run identity, checkout paths, and branch names.

Preserve explicitly chosen names. A manual rename or an accepted naming suggestion locks that name against automatic updates until the user explicitly unlocks it or requests another rename. Existing names with unknown provenance receive suggestions only. The optional future automatic mode may refine an explicitly managed, unlocked generated name at the planning checkpoint; later scope changes produce suggestions. Verify the current title still matches the title evaluated before applying a suggestion, so a delayed response cannot overwrite a newer manual rename.

Add a **Review names** action in the workspace inspector. Show current and proposed workspace/agent/terminal names, a short reason, editable suggestions, and **Apply selected**. Include per-item lock state and undo for a successful rename; undo must not overwrite a subsequent rename. Use the installed public API for each resource and mark unavailable actions clearly, especially existing terminal renaming, whose support must be verified before implementation. A locked name remains unchanged unless explicitly selected for a user-requested rename.

First implementation order: wire the shared naming policy into the existing workflow skills, then add the Review names preview and guarded apply actions. Optional automatic updates come after naming ownership, locks, and restart persistence have been verified. Keep work state such as Review and Blocked in workspace status labels rather than appending it to every tab title.

## 3. Agent ownership and orchestration

Use an explicit `orchestrator` role or mission assignment in our records. Do not label an agent an orchestrator merely because its title says so. Show a managed Paseo child under its `parentAgentId` when that relationship is exposed. Each row has host, workspace, role, task, current status, last observed action, pending request, and an **Open agent** action.

One orchestrator may coordinate several independently created workspaces. Those agents need an explicit `missionId` and assignment links; a native parent-child relation alone may not describe that cross-workspace or cross-host ownership. For provider-internal subagents whose IDs or activities are unavailable through the SDK, show “reported by parent” with source and timestamp, never an invented agent session. Agent Crew and Agent Monitor, already part of the user's exploration, are reference implementations for trees and presence; Mission Control should link or complement their views while the native fields are checked.

Example: an orchestrator imports Jira issues, requests approval for a bounded work batch, creates or assigns workspaces under the applicable scope, and delegates builders/reviewers. Its mission page shows each ticket, host/workspace, child agent, last progress, blocker, review/delivery position, and whether cleanup is pending. A child that outlives its parent remains visible by its stable mission assignment.

## 4. Needs You and workspace status

**Needs You** is a decision queue, not a list of every idle agent. A card identifies host/workspace/agent/task, the exact question or proposed action, options, recommendation if present, relevant plan or code revision, supporting evidence, age, and the next action. Types include provider permission, workflow question, plan approval, review sign-off, delivery authorization, and cleanup approval. Answer a provider permission through Paseo's supported permission mechanism; record workflow decisions in the owning Host Brain record. A stale decision tied to an earlier plan or code revision must be refreshed before use. Offer **Submit & Next** after a successful recorded answer, with errors visible if the host disconnected or the decision changed.

**Workspace status** is requested from its panel or task detail. First gather deterministic facts: number and role of managed agents, last observed activity with timestamp, last completed or attempted stage, task and branch links, pending permissions, validation/review evidence, known PR/merge state, and last successful host observation. A small independent read-only summarizer can then explain what the agents were doing and suggest the next action, linking its evidence. Do not interrupt a busy builder to produce a status report. Mark “suspected stalled” only with a stated rule and observations such as no new activity after a configured interval while a turn is expected; offline or idle alone is inconclusive. A stale snapshot is labeled “last observed,” not presented as live.

### Workspace labels and status

25 September 2026 · Confirmed requirement: visible native Paseo workspace labels must include work status, particularly **Review** and **Blocked**. Label display/editing/filtering in Mission Control and automatic synchronization are planned work, not current plugin behavior.

Start with this shared vocabulary:

| Status label | Meaning |
|---|---|
| **Ready** | Work is scoped and ready to start |
| **In Progress** | Work is underway |
| **Review** | A result needs review or approval |
| **Blocked** | An unresolved dependency or decision prevents progress |
| **Paused** | Work has deliberately been set aside |
| **Done** | Work is complete |

Optional purpose labels are Feature, Bug, Maintenance, Research, and Tooling; **Focus** marks work the user currently wants to prioritize. Keep labels concise and use consistent names and colors across hosts. Paseo's label catalog is host-local, so matching labels across hosts require deliberate setup; catalog synchronization is a separate future feature. Agent key/value metadata for task IDs and roles is distinct from these visible workspace labels.

First build manual label assignment in the workspace inspector, compact chips on workspace rows, and a label filter that composes with host/project, online, Has tasks, and Active tasks filters. Attention can use the labels of each item's owning workspace. Preserve label selection when switching views. Saved combinations such as Online + Focus + Active tasks are a later convenience.

A workspace may contain tasks at different stages: allow **In Progress**, **Review**, and **Blocked** together when different linked tasks justify them. Selecting the workspace should expose the underlying tasks and reasons. A manually assigned label is a user classification; it is not evidence that validation, approval, or delivery occurred, and it must not mutate task status or start an agent.

Offer automatic status labels only as a later opt-in mode for workspaces whose linked task data is available. Derive In Progress, Review, and Blocked from actual task/run/decision evidence, not from an agent merely being idle, finished, or offline. Ready requires an explicitly ready task; inbox alone is insufficient. Paused stays manual until an explicit pause record exists. Apply Done automatically only for a nonempty set of linked tasks when every task is delivered or closed and the owning data is current and complete. An empty or unavailable task set cannot prove Done; missing data must not silently remove labels or invent a status.

Automatic updates must have explicit ownership of the status labels they manage and preserve unrelated/manual labels. Detailed lifecycle, plan/implementation/validation/review evidence, approvals, and eventual ICE scores remain in the task/run records. A status label never grants delivery, merge, or cleanup permission. Verify the installed public workspace-label APIs before implementing any mutations.

## 5. Tasks, delivery, and cleanup

A task may be entered by a person, imported from Jira/ADO or another tracker, or added by an agent through a real task command. The tracker remains authoritative for its issue fields; the Host Brain owns our execution record. An imported issue keeps `{provider, account/project, externalId, URL}` for deduplication. Import is proposed or performed only within the authorized tracker scope; an agent's chat claim does not create a task until the validated record write succeeds.

Task records have one owning `hostId` and project, stable `taskId`, source, title, acceptance criteria, priority, owner/mission, and lifecycle (`inbox`, `ready`, `in_progress`, `blocked`, `in_review`, `delivered`, `closed`). Link one task to one or several `{serverId, workspaceId, agentId?}` assignments instead of making workspace names the key. Record Git repo, branch, base, local commits, pushed revision, PR URL/forge ID, checks, review, merge revision/target, and verification as **evidence** with source and timestamp; a squash merge need not preserve the local commit SHA. Do not automatically close a task at commit or merge: required verification, tracker update, or human acceptance may remain.

Workspace cleanup has its own lifecycle: `active` → `candidate` → `approved` → `archived`, with `blocked` for unresolved evidence. A candidate is suggested only after checking linked tasks and assignments, branch and PR state, uncommitted changes, pending review/permission, agent activity, and worktree ownership. Show the exact evidence and missing checks. Archiving a Paseo workspace and deleting a Git worktree are separate actions; neither is implied by task closure or an inactive agent. Refresh status immediately before an approved cleanup action. Expose a periodic **Cleanup** queue so merged workspaces do not disappear from attention.

## 6. Durable records and host access

The [Dev Vault design](mission-control/dev-vault-design.md) defines the task-folder layout and the new read/edit Docs tab. The pilot Host Brain vault is the source of truth for task/run/decision evidence. Use compact Markdown with typed frontmatter and per-event append records, consistent with the roadmap's canonical run state. Index keys are `hostId`, `projectId`, `workspaceId`, `agentId`, `missionId`, `taskId`, `runId`, `decisionId`, and timestamps. Keep role/parent assignments, external tracker keys, and delivery evidence in linked records. Include schema version and provenance for every fact; the UI can render “unknown.” Store UI preferences in plugin settings if useful, never duplicate authoritative task completion state there.

The Paseo client may discover configured hosts with `useHosts()` and borrow each online host's API with `getPaseoClient(serverId)` for live projects, workspaces, agents, and navigation. That alone does not give the originating plugin access to arbitrary files or credentials on another host. When vault reads/writes are needed, install a scoped daemon-side adapter on the owning host, exposing narrowly defined RPCs/commands with validation, authorization, and concurrency control. Start with one host's file adapter and expand only after a real record contract exists; offline hosts can show a timestamped last-known index, never accept a misleading silent write.

If the workflow later needs cross-host coordination, give one owner to each mutable task/run record, route commands by stable host/record ID, and return a result or explicit failure. Reconcile current Git, tracker, and Paseo states on resume. Protect against duplicate scheduled imports, two agents writing one daily roll-up, revision races on decisions, and task duplicates across imports. A dashboard cache is disposable and rebuildable from owning host records and external systems.

## 7. Chat entry points and daily routines

`tell-agent` demonstrates a `/tell target :: message` command that resolves an agent on the same daemon and asks the source agent to forward it; it is not a cross-host direct messaging API. `paseo-defer` demonstrates the same action offered as a composer pill, slash command, workspace panel, and sidebar surface, backed by its own durable queue. Apply that pattern to Mission Control: `/task add …` proposes a validated task record, `/task link …` links a selected workspace, `/mission` opens the current mission, and `/status` opens or refreshes the current workspace brief. A slash command executes on the client, so agent-initiated task changes require an explicit command/tool with scoped backend validation and an acknowledgment, not transcript scraping. Composer pills should reveal active task or pending decision without taking over the chat.

The morning scheduled agent reads the owning host's vault and authorized tracker, deduplicates imported tasks, reconciles current work, and proposes or starts work within the already granted scope. The nightly scheduled agent records an honest checkpoint, delivery/cleanup candidates, and the exact resume point. These routines start fresh agents; they should not create duplicate workspaces or claim a running builder has stopped. The plugin displays their records and lets you navigate to the agent and evidence; it is not the scheduler or the task authority.

## 8. Implement in slices

| Slice | Build | Acceptance on the user's Paseo installation |
|---|---|---|
| 0. Pilot contract | Select installed app/daemon version, main host, second reachable host, one project on each, stable IDs, a minimal host/project profile; verify SDK exports and navigation | Know which fields exist in that installed version and how a plugin is reloaded |
| 1. **Installable navigation plugin** | Scaffold via `paseo plugin init`; full surface and sidebar entry; host-first tree, workspace rows, agent status and managed parent relationships, direct open action, errors/offline labels | Two hosts appear, including offline host; open goes to the correct host/workspace/agent; refresh/restart works; no workspace, agent, or Git mutations |
| 2. Task foothold | One manual task in a pilot vault, stable IDs, task ↔ workspace link, basic workspace panel, validated local read/write adapter | Add and reopen a task; correct workspace and owner shown after plugin restart; duplicate external IDs rejected |
| 3. One-ticket development flow | Individual kit skills and one actual ticket; agent progress/run/decision records; review evidence | Status cites what actually ran; a fresh session can resume the ticket from its handoff |
| 4. Operational control | LFG composition, Needs You decisions, Jira/ADO import, delivery and cleanup queues, AI brief, schedules, second host vault adapter | Approvals survive restart; tracker/merge states reconcile; nothing closes or archives solely because a turn ended |

For slice 1, begin with Paseo's generated plugin. The third-party [paseo-plugin-helper monorepo package](https://github.com/xpufx/paseo/tree/main/packages/paseo-plugin-helper) is a **developer library**, not a plugin installation. We reviewed version `0.4.0-beta.12` at commit `378bb5e` and ran its audit CLI on this plugin: zero errors, four style warnings about direct React Native primitives. Its responsive and scroll guidance is useful, but adding its beta runtime for this small surface is optional. Revisit individual components if they solve a demonstrated mobile issue. Use the current plugin SDK's `index.client.tsx`, `addSurface`, `addSidebarItem`, and read-only host APIs. The current public docs show `addWorkspacePanel`, commands, pills, and daemon RPC for later slices. Check API/version compatibility locally: documentation and third-party plugin manifests can move ahead of the installed app. In particular, probe native tab inventory, cross-host `navigation.openAgent/openWorkspace`, parent lineage, and permission response behavior before hardcoding UI actions.

For slice 1 testing, seed one orchestrator label and one managed child if the SDK supports it; use a separate explicit mission assignment for a workspace created independently. Simulate disconnecting the second host. Verify distinct idle/waiting/offline/error states, the absence of guessed activity, responsive layout, reload cleanup of subscriptions, and keyboard/phone navigation. Write a small focused test only for host-scoped grouping/routing if it is easy to target the wrong host.

## 9. Review Deck adoption and Jev decision-layer plan

Research and acceptance criteria: [Review Deck and Jev notes](source-notes/review-deck-and-jev-research.md), 23 September 2026. This is proposed work, not completed functionality or authorization to install tools.

Add a task/run-scoped Review surface borrowing diff navigation, hunk comments, reviewed progress and explicit selected-agent handoff. Persist findings in dev-vault as Open → Submitted → Awaiting verification → Resolved. Snapshot submitted finding IDs and versions; never clear a project's comments after an asynchronous send. Preserve damaged storage and enforce reviewer permissions through the provider.

Quick access (requested 25 September 2026): add a Mission Control composer pill above each agent's chat, using the SDK's `PluginComposerPillContribution`. It shows the linked task's review state, for example **Review · 4 files · 2 open**, and opens the Review workspace panel scoped to that agent's task and run. Hide it when the agent has no linked task. Add a matching `/review` slash command and Command Center item. Build the diff viewer as a shared component so the panel and the Mission Control Review tab render the same view. Adapt code from MIT-licensed Review Deck with attribution.

Layout target (user preference, 25 September 2026): match Review Deck's clean review layout, which makes it obvious what to review next.

- **Header:** title with a review-state badge, then a short context row: task, workspace, diff source, and snapshot state with generation time. Snapshot state must be truthful (current, stale, failed); never show a done badge after a failed collection.
- **Two panes on wide screens:** a changed-files list on the left (path, change-block count, +/- lines, comment state, reviewed check) and file detail on the right. Compact screens drill down from the list to the detail view.
- **File detail:** path, block count and +/- summary; a Split/Unified toggle; previous/next change-block navigation with "Change block 2/5"; OLD/NEW columns with line numbers and quiet red/green backgrounds.
- **One comment box per file** beneath the diff, anchored internally to the viewed change block, saving into the task's findings.
- **One primary action** in the header for sending findings to the task agent, showing the pending count.
- Keep secondary actions (explain, revert) behind a menu; no AI explanation in the first version.

Support unborn HEAD using an appropriate empty-tree baseline, including staged and untracked files. Invalid explicitly selected revisions remain errors. Test staged/mixed/untracked states, normal/detached HEAD, binaries, renames, deletions and empty scope. Do not create a commit to enable review. Loading/empty/stale/error/current states must be truthful; failed collection cannot show DONE/current evidence. Defer destructive revert actions.

Place an optional Jev server DecisionAdapter after deterministic scope/capability checks and Gortex/vault retrieval, before dispatch; reuse it for evidence-gap screening afterward. Mission Control owns routing policy, Paseo owns sessions/permissions, Development Kit owns workflow requirements, and dev-vault owns durable evidence. Jev never grants approval or certifies completion.

Prototype in order, after separate implementation authorization:

1. Shadow task/agent routing through the official SDK, borrowing Auto Mode's overrides and stable-session principles. Keep provider-neutral contracts; an Auto Mode installation is an isolated Codex pilot.
2. jev-mcp context ranking after Gortex retrieval, preserving mandatory instructions, contracts, changed symbols and impacted tests.
3. Evidence/review triage borrowing jev-review staging and jev-belay's evidence-first pattern, backed by revision-specific run records and independent review.
4. Bounded jev-browser QA on disposable fixtures with independent assertions, traces, budgets and escalation.

Bind decisions to exact identity, revisions and dirty/untracked content fingerprints; reject stale/cancelled results and deduplicate dispatch. Classifier failure retains required context and the configured ordinary agent. Missing validation remains unverified. Jev Kit's fail-open hygiene hooks cannot serve as security/completion controls.

Evaluate held-out tasks in shadow mode before automation: total cost per correctly completed task, latency, rework, context recall, missed defects, false completion and overrides. Pin versions, minimize/redact outbound context and calibrate by question/risk. No application implementation or installation is included in this update.

### Review status and backlog (25 September 2026)

Built: Review tab and side-by-side Review panel; HIGH/MEDIUM/LOW/INFO labels with reasons; reviewed marks per change block and file; "review since commit"; file and line comments sent into a chosen agent's chat (not sent → sent → resolved, never deleted once sent, unconfirmed sends need the user's confirmation); Review bubble on local agents in Git workspaces.

Next, in order:
1. Record each comment send as a Paseo timeline row, and optionally link comments to the active task run so they appear in Needs you as findings.
2. Whole-file view: the full file with changes and comments in place (Review Deck's "Full changes view").
3. Rule analysis per block with Gortex facts: callers of changed symbols and affected tests.
4. AI review of a file or block in a read-only child agent; show facts and inferences separately and cancel on timeout or permission.
5. Revert a block or file, only behind confirmation, a stale-snapshot check, a backup of new files and correct handling of staged changes.
6. Review defaults in a settings screen (layout, default scope).

### Right panel (Explorer): Mission tab

Built 26 September 2026. Paseo's right panel has Files and Changes; Mission Control adds one compact **Mission** tab per workspace rather than duplicating Changes:
- **Needs you:** permission prompts with the agent's own choices (Allow/Deny by default), and this workspace's open plan/review decisions with inline answers. This closes the gap found in the Needs you pilot, where a permission sat unanswered for over an hour.
- **Tasks:** active tasks with a Plan → Build → Validate → Review → Handoff stepper, outcome, next action and the run's agent.
- **Review:** files still to review, unsent comments, and sent comments awaiting Resolve, with Open Review.
- **Agents:** status (including "waiting for permission"), role and provider.
It opens from a **Mission** header button on each active workspace, which reads "N need you" while prompts or decisions wait, and from `/mission`. Start/Resume and sending comments stay in the task dialog and Review for now.

### One worktree per task

Built 26 September 2026: Start task can create a `task/<id>-<title>` worktree workspace, records it on the task, runs the agent there, and reviews everything since the branch point. See [One worktree per task](agent-workflow.md#one-worktree-per-task). Merging the branch back remains an authorized delivery step.

## 10. Sources to inspect during implementation

- [Paseo plugin quickstart](https://paseo.sh/docs/plugins) and [plugin reference](https://paseo.sh/docs/plugins/reference): scaffold, surfaces, panels, slash commands, composer pills, RPC, cross-host discovery.
- [Paseo agent SDK](https://paseo.sh/docs/sdk/agents) and [workspace SDK](https://paseo.sh/docs/sdk/workspaces): managed child, agent state, placement, archive boundaries.
- [Paseo plugin helper](https://github.com/xpufx/paseo/tree/main/packages/paseo-plugin-helper): third-party client UI primitives, mobile layout guidance, and audit CLI; review API and version before adopting a runtime dependency.
- [Tell Agent](https://paseo.cafe/plugins/tell-agent/) and [Paseo Defer](https://github.com/tomgrin10/paseo-defer): composer entry and persistence patterns.
- [Existing plugin catalog review](paseo-plugin-reference-review.md): dated survey of Agent Monitor, Agent Crew, Review Deck, PR Radar, and other examples. This document supersedes its proposed build order.
