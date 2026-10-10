# Mission Control for Paseo

Install this plugin on the `personal` Paseo daemon. Its full surface opens on **Workspaces**: a searchable host rail, a project and workspace list with search and agent-state filters, and a workspace inspector. The **Attention** tab shows what needs you as compact cards. Each card gives the task line, where things stand (the agent's own summary, or a trimmed quote of its latest message; a closed or errored agent's chat is read only when you open Conversation, because reading it wakes the agent), what's needed from you, the answer buttons, a collapsed **Conversation** and a small **Open agent** link. It lists permission prompts from every online host (with what the agent **Wants to** do), **Waiting for you** cards with a Reply box (questions agents recorded with `dev-flow.mjs ask` on this host, and agents Paseo flags with an error on any online host), this host's open plan and review decisions in plain language (a recommendation, buttons named for what they do, and per-finding Fix now / Skip choices under More, with the summary, evidence and file references under Technical details), approved tasks ready to deliver with their Merge or Open PR button and checks, each delivery's result until you dismiss it, and open pull requests. A merge or pull request that takes longer than about 20 seconds carries on in the background, and Attention shows its progress and result. The host rail, workspace list, and inspector scroll independently on wide screens. The small icon beside the title toggles Paseo's sidebar on web. The layout stacks on narrow screens.

The roster uses Paseo's configured host connections. A host can appear in the desktop client without this plugin installed there. Online rosters refresh every 20 seconds. Each request uses Paseo's 200-item page limit and warns if more entries remain. Offline cached data is marked as last observed. **Attention** reflects Paseo's agent flag only; it is not a workflow approval or decision record.

## Pilot task records

The inspector lists linked tasks for a selected local workspace. The **Tasks** workspace panel can add and reopen a manual task with acceptance criteria. The daemon adapter writes `task.md`, `status.md`, and `notes.md` in a task folder under `C:\dev-vault\Tasks` on `personal`. The Docs tab also reads recent run and handoff evidence from that folder. `C:\dev-vault\host.json` declares that host's stable `hostId` and Paseo `serverId`; RPC calls must match it, and task creation checks that the workspace exists on the local daemon. The pilot task is linked to the `development-flow` workspace. Creating a record does not create an agent or change a workspace.

Create `C:\dev-vault` separately on each Windows host before installing the adapter there. Give each vault its own `host.json` with that host's actual IDs. The `personal` vault is registered as a Paseo project. This plugin currently reads and writes only its installation host's vault; seeing another host's roster in the desktop app does not grant access to its files.

```powershell
cd C:\Code\development-flow\plugins\mission-control
npm install
npm run typecheck
paseo plugin install C:\Code\development-flow\plugins\mission-control
paseo plugin reload mission-control
```

The 0.9.1 cross-host agent list supplies workspace assignment and status but omits managed `parentAgentId`. Subagent badges require an explicit parent field or `mission-control.parent-agent-id` label; roles use `mission-control.role` and are never guessed. Workflow runs and handoffs are readable. Current decision, delivery and manual agent-cleanup actions are described below; host-specific records and settings belong to the installation host.

## Agents panel

The **Agents** panel in Explorer (Command Center: **Open Agents**) shows every non-archived agent of the workspace as a tree. Sub-agents sit under their parents, with collapsible rails and counts, even when they work in another workspace. An agent from another workspace that started one here is shown dimmed and can only be opened. Unrelated branches are left out, and parent loops are cut short.

- **What each row shows:**
  - Rows carry a state, the provider and model, the workspace, the Mission Control task and role, the last error and the age.
  - They also carry a one-line "where it's at". It comes from the agent's own summary when Paseo sends one, else its latest Dev Flow run's next step, else its latest message.
- **Helpers:** helpers inside an agent's turn (Claude Code's Agent tool) are listed under it on the host running this Mission Control. Finished helpers fold into a count.
- **Stopped agents stay stopped:** Paseo restarts a stopped agent to read its chat or list its helpers. So Mission Control doesn't ask about a closed, errored or archived agent: it lists no helpers for it, and it shows a button instead of its latest message or first prompt. Before listing helpers, the server checks each agent's current status again, so an agent that stopped a moment ago, or before a daemon restart, isn't woken.
  - One rare exception: after an unclean daemon exit, Paseo can still list a stopped agent as idle or running. Such an agent is asked about, and so restarted.
- **States:** the filter chips count Needs input, Failed, Working, Ready, Idle and Closed. Precedence is Failed, Needs input, Working, Ready, Closed, Idle.
  - Needs input includes permission prompts and open decisions. Recorded questions will count too once they land (task 24).
- **Search:** search covers the title, ID, provider, model, task, workspace, role and labels.
- **Actions:** Open, Reply, Interrupt and redirect, Detach, Archive, and Allow or Deny a permission. Each one is confirmed in plain words first.
- **Live updates:** the tree follows Paseo's agent and workspace subscriptions, one per host shared by every view. Updates are debounced by 500 ms, with a 30-second backstop.
- **Same tree elsewhere:** the Workspaces page and the Mission panel use the same tree and rows.
- **Auto-open:** **Settings → Plugins → Mission Control → Agents panel** can open the panel once for each new workspace. It is off by default. Opened workspaces are recorded in `~/.paseo/plugin-data/mission-control/agents-auto-open.json`.

Parts of the panel are adapted from Agent Crew (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Agent cleanup

The broom beside an agent's pencil scans its family; the bordered header broom scans the workspace. The preview groups Eligible, Keep and Couldn't verify, explains archive/detach consequences, and selects nothing automatically. Confirm only the eligible families you choose. Running agents/helpers, unfinished tasks, pending input, open tabs, pinned workspaces and unverifiable records are protected. Every selected family is checked again immediately before archive, and results remain visible when a row disappears.

**Settings → Plugins → Mission Control → Agent cleanup** sets this host's retention: 7 days for delivered/closed task conversations and 14 days for unlinked conversations by default. Unlinked families require individual selection. This is manual archiving with retained history; task records, workspaces and branches are preserved. Merged-PR delivery cleanup uses its separate existing checks. See [Agent cleanup](../../docs/agent-cleanup.md) and the [user guide](../../docs/user-guide/mission-control-user-guide.html#agent-cleanup).

## Orchestrator workspaces

**Workspace status labels:** the server keeps each workspace's Paseo status label (Ready, In Progress, Review, Blocked, Done) in step with its tasks: a minute after start, every minute, and after a task status change (`server/workspace-labels.ts`, rules in `shared/workspace-status.ts`). A workspace with one active task shows that task's status; a shared workspace with several is left to its coordinator; Done needs every linked task finished and no running agent; a Paused workspace keeps its labels. Only changes since the last applied status are written (`<PASEO_HOME>/plugin-data/mission-control/workspace-status-labels.json`), so a hand-set label stays until the work moves on. An agent label `mission-control.workspace-status=<ready|in-progress|review|blocked|done|none>` on any agent in the workspace overrides the tasks, which is how orchestrators mark another host's workspace: `paseo agent update <agentId> --label mission-control.workspace-status=review --host <host>`. Labels need Paseo's internal `DaemonClient` (PaseoApi 0.9.1 has none); a daemon without them turns the sync off.

An orchestrator workspace is a workspace on this host where one agent drives another host's work. Its folder names that host in a `host.json` with no secrets: `{ "schemaVersion": 1, "label": "Acme", "serverId": "srv_…" }`. The server reads it for this host's workspaces only (`orchestrator.bindings`). A file without `label`, such as a vault's own `host.json`, isn't a binding, and a file naming this host itself is refused.

- **Bubbles:** every open chat in the workspace gets `Acme agents`, with the remote host's count of agents that need you, and a host-level `Review` that counts workspaces labelled Review, else other workspaces with changes. The counts come from the remote host's Paseo, read at most once a minute; an unreachable host keeps its last counts. They replace the workspace Review bubble, which would review the orchestrator's own folder. If the binding lookup doesn't answer within 3 seconds, the chat keeps its usual Review bubble for that poll.
- **Host agents tab:** `Acme agents` opens a Host agents tab (a workspace panel) with the main page's menu, for that host:
  - **Workspaces:** projects and workspaces read live through Paseo's client connection, so this works whether or not Mission Control is installed there. Search, Show (without the task filters), label and project filters, and collapsible projects. Rows show status, labels, agents, last activity, branch, lines added and removed, uncommitted or unpushed work, and the pull request with its checks and review. A workspace opens its agent tree, with **Open review**, **Tasks** and Open workspace.
  - **Attention, Tasks, Review and Docs:** the main page's views, reading that host's own Mission Control: its permission prompts, questions and decisions with Merge or Open PR; its vault tasks with Start and Resume; Mission Control's Review of the chosen workspace; and its vault documents.
- **Review list:** the `Review` bubble opens the tab's review modal, and the Review tab lists the same when no workspace is chosen. Workspaces labelled Review come first, then workspaces with changes whose agents have all stopped, except ones labelled Done or Paused. **Open review** shows that workspace in the Review tab; Open workspace navigates to it on that host.

**Reaching another host's Mission Control.** Paseo evaluates every connected host's copy of Mission Control in one app. Each copy asks its server for the host's server ID (`host.identity`) and registers on `globalThis.__missionControlCopies` with a bridge protocol number, retrying every 30 seconds until its server answers. The shared views take `useRpc` from `client/host-rpc.tsx`: inside a `HostRpcProvider` it calls the registered copy for that host, which calls its own server, so the remote host's checks and records apply. A copy answers only the shared views' contracts (tasks, runs, launch, decisions, questions, merge, pull requests, delivery text, review, vault, helpers and agent names), never setup, tools, settings, updates or cleanup. When the host is offline, has no Mission Control, or runs a copy on another bridge protocol, the tab says which and what to update.

Workspaces that Paseo sends without an activity time show their latest agent's activity or when they entered their current status, here and on the Workspaces page.

## Morning check

The workspace page's **Morning check** section starts an agent with the kit's `morning-check` skill, shows the latest report from `C:\dev-vault\Daily`, and imports the current-sprint Jira or Azure DevOps items you pick as tasks with their ticket. The agent reads the tracker through its own MCP tools; this plugin never calls Jira or Azure DevOps. See [Morning check](../../docs/agent-workflow.md#morning-check).

## Workflow instructions

**Settings → Plugins → Mission Control → Workflow instructions** saves separate Intake and Planning guidance in this host's vault. Projects can inherit, add to, or replace the host defaults independently for each stage; the effective preview shows the combined text and source note paths. Use this for clarification preferences, Confluence references and read-only database checks. Morning check receives Intake guidance; task Start / Resume, `/mission-task` and `dev-flow context` load both stages. Save affects the next prompt/context read, without interrupting running agents. Notes do not add tool access or delivery permission. See [Workflow instructions](../../docs/workflow-instructions.md).

## Branch names

**Settings → Plugins → Mission Control → Branch names** sets how a task's worktree branch is named: a template for the host, and optional overrides per project. The tokens are `{ticket}`, `{slug}`, `{type}` (feature or bugfix) and `{id}`. Start task previews the name. Tasks without a ticket, and hosts without a template, keep `task/<id>-<title>`. See [One worktree per task](../../docs/agent-workflow.md#one-worktree-per-task).

Under each project, the screen also shows the branch guidance in that project's `paseo.json` (`metadataGeneration.branchName.instructions`), with the file it came from. It's read only: it guides Paseo's own branch names, while task branches keep using the template.

## Delivery

**Settings → Plugins → Mission Control → Delivery** sets how Attention delivers an approved task: **Merge** (into the main checkout, for personal projects) or **Pull request** (for work repositories). There's a host default, and optional overrides per project. Pull request also has a title template with the branch-name tokens plus `{title}`, by default `{ticket}: {title}`. The target is the project's default branch (Workspaces tab), else origin's HEAD branch.

Commit messages and pull request text follow the repository's `paseo.json`, the same instructions Paseo's own Commit button uses (`metadataGeneration.commitMessage` and `.pullRequest`). Mission Control only reads `paseo.json`: first in the task worktree, then in the checkout it was made from, because an uncommitted `paseo.json` isn't copied into worktrees. When the confirmation opens, a small model (Haiku, else GPT-6-Luna on low) writes the text in a short-lived agent. It gets only the task's title, ticket key, handoff summary and those instructions. For a pull request, it also gets the repository's pull request template, if there is one, so the description keeps the template's sections. The template is cut to 6,000 characters, and key-like strings in it are hidden. No other file content is sent. The confirmation shows the text, editable, and the run uses exactly what it shows. A pull request title keeps the ticket key, and a written description ends with the ticket link. Without instructions, or when writing fails, the defaults stay: `<title> (<task ID>)` for the commit, and for a pull request the title template and a body made of the repository's pull request template and the handoff summary. **Use the default** skips waiting.

The same screen shows each project's forge and repository, or Unknown:
- detected from origin's URL;
- mapped by a **custom host** (a GitHub Enterprise domain, an Azure DevOps Server, or an SSH host alias such as `github-work` in `git@github-work:org/repo.git`, each mapped to GitHub, Azure DevOps or Bitbucket Cloud). An http(s) remote keeps its scheme and port, such as `http://tfs:8080/tfs/DefaultCollection`. For an SSH remote, the custom host's web address can be a base URL. Azure DevOps Server accepts `az devops login` as signed in;
- or set by the project's forge override.

The override wins, then the custom hosts, then detection. Setup shows gh, az and Bitbucket credentials only for forges these projects use, and checks gh on each GitHub host they use.

For a pull-request project, **Open PR** replaces Merge in Attention's Ready list.
- **Checks:** Merge's checks without the main-checkout ones (review approved for exactly these files, agent idle, nothing in progress, work to deliver), plus:
  - origin is on GitHub, Azure DevOps Repos or Bitbucket Cloud;
  - the forge's tool is signed in: `gh`, or `az` with the azure-devops extension, or Bitbucket credentials exist;
  - no pull request is recorded yet.
- **Confirmation:** it lists the commit with its editable message, the push, the draft pull request's forge and target with its editable title and body, and the exact commands and request. **Dry run** returns the commands with the text shown, without changing anything.
- **Run:**
  1. Commit the uncommitted work.
  2. Push only the task branch, as `git push origin <commit>:refs/heads/<branch>`. It's never forced: if origin's branch has commits the task lacks, nothing is pushed.
  3. Open the draft:
     - GitHub: `gh pr create --draft`.
     - Azure DevOps: `az repos pr create --draft true`, linking the ticket's work item. On Windows, az runs as `python.exe -IBm azure.cli`, as `az.cmd` does, with no shell.
     - Bitbucket Cloud: `POST …/pullrequests` with `draft: true`.
  4. Record the pull request's URL and number in `task.md` and set the task to In review.
- **Body:** the repository's pull request template if it has one, then the latest handoff's summary and the ticket link.
- **Bitbucket credentials:** `BITBUCKET_TOKEN` (Bearer), or `BITBUCKET_USERNAME` and `BITBUCKET_APP_PASSWORD`, in the Paseo daemon's environment. Otherwise a bitbucket.org credential from Git's credential store, read with `git credential fill` with prompts and windows off. They're never stored, logged or shown.
- **Output:** tool output is shown with key-like strings hidden.

Attention's **Pull requests** list reads each pull request's state (draft, open, merged or closed) when it opens, on Refresh, and on **Check status**; it never polls.
- **Merged:** shows **PR merged** with **Clean up**. Clean up reads the state again, then archives the worktree workspace, deletes the local branch and marks the task delivered. It never runs by itself. It needs the forge to say the pull request merged, and the local task branch to have no commit the pull request didn't contain. Review fixes pushed to the pull request are fine.
  - When the final head commit is here, the branch must be at or behind it.
  - When the head exists only on the forge (after Update branch, or a squash merge that deleted the branch), the branch's own commits are compared with the forge's list of the pull request's commits.
  - A local branch that is already gone has nothing left to lose.

  It refuses, and changes nothing, when the branch has commits the pull request didn't contain, when that can't be checked, or when the worktree has uncommitted changes.
- **Closed without merging:** offers no cleanup.

Every Merge, Open PR and Clean up result stays in Attention, with each step's outcome, until you dismiss it, even after the task leaves the Ready list. Results are kept in `~/.paseo/plugin-data/mission-control/delivery-results.json`. One still running when the plugin restarts shows as interrupted. Setup shows whether gh and az are installed and signed in, and whether Bitbucket credentials exist.

Timed Git calls (merge, commit, fetch, push, and Start task's dev-flow context check) end their whole process tree at the time limit. That includes Git for Windows' `cmdgit.exe` launcher, the real git it starts, and hooks. The repository is re-read only after they've exited. If that can't be confirmed, the result says the state is unknown, and nothing is unlocked, aborted or reset.

## Updates

**Settings → Plugins → Mission Control → Updates** shows, for the host selected in Paseo's host picker:
- the installed version (`version` in `package.json`, mirrored in `shared/version.ts`);
- where Mission Control was installed from;
- the result of Paseo's update check, which runs when the page opens and on demand.

When an update is available, **Update** asks for confirmation. It then checks again that the update is still the one you reviewed, and runs `paseo plugin update mission-control` on that host. Paseo downloads, builds and reloads the plugin. Nothing is updated automatically, and Mission Control's dependencies (kit, skills, tools) and the vault are not changed.

Updates follow the same model as the Gortex plugin in `discwl/huginn`: for a Git install, each new commit on the repository's default branch is an update. Paseo records only the repository, not the branch, so `--ref` picks only the first installed version. Later updates always come from the default branch. A folder install, as on `personal` today, can't update from Git. Pull into the folder and run `paseo plugin reload mission-control` instead.

The supported installation for [discwl/mission-control](https://github.com/discwl/mission-control) is a full repository checkout plus a local plugin-directory install. Follow [Install Mission Control on a host](../../docs/install-mission-control.md), which includes private read-token settings, workflow-kit and fixed Windows vault setup, updates, and a short agent prompt.

Update that checkout with `git pull --ff-only`, run `npm ci` and typecheck in `plugins/mission-control`, then reload the plugin. Keep project profiles' `kitRoot` pointing to the same complete checkout. This keeps skills, scripts and review rules available alongside the plugin and does not require removing the installed plugin or resetting layout settings.

A direct Git plugin install with native one-click updates still needs build preparation and a verified complete-kit setup strategy; it is not the installation path validated for this publication. Never put a token in the remote URL: Paseo stores the remote in plain text in `~/.paseo/plugins/sources.json`.

## Setup

**Settings → Plugins → Mission Control → Setup** shows, for the host selected in Paseo's host picker, each dependency in `shared/setup-manifest.json` with one status: Installed, Outdated, Missing, Modified, Not managed or Unknown. It covers Paseo, the Development Flow kit (each project profile's `kitRoot`; a developer checkout is updated with Git), the vault and its `host.json`, skills per provider, the tools (Node, npm, Git, gh and az with their sign-in, Bitbucket credentials, Gortex, the OCR CLI and rule files, Obsidian and its CLI) and the provider CLIs. Versions come from files where possible. The only commands it runs are the manifest's version commands and read-only sign-in checks (`gh auth status`, `az extension show`, `az account show`, and a prompt-free `git credential fill` for bitbucket.org, of which only whether a credential exists is kept), as `.exe` files without a shell and with timeouts. Obsidian is never started.

It installs only three things, each after a confirmation that lists the command or every path:
- **Skill links:** junctions from `~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills` and `~/.copilot/skills` to the kit's `skills/*` and to the pinned `docs/ocr-kit/open-code-review-delegate`. Each folder's `.mission-control-managed.json` records the links Mission Control made. Anything else with the same name is Not managed and never replaced.
- **OCR CLI:** `npm install -g @alibaba-group/open-code-review@<pinned>`, run as `node npm-cli.js …` (no `npm.cmd`, no shell).
- **OCR rule files:** copied from `docs/ocr-kit` into `~/.opencodereview` only when missing, or when unchanged since Mission Control last wrote them (SHA-256 in that folder's `.mission-control-managed.json`). Edited files are Modified and left alone; an existing `rule.json` is never merged.

Each install checks again just before it changes anything and stops if something changed since the confirmation. An install that takes longer than 20 seconds (npm on a slow network) keeps running on the server; the screen says so and follows it until its result arrives, and other installs wait. Results, with key-like strings hidden, go to `~/.paseo/plugin-data/mission-control/setup-log.jsonl` (last 100) and show under **Recent installs**.

## UI layout

Tasks and Docs use the main pane. Tasks offer compact list/board cards with details in a dialog; Docs offers a task folder tree, Markdown source/preview, and an Obsidian deep link. See [UI direction and verification](../../docs/mission-control-ui.md) for mobile behavior, parent-agent API limits, and editor scope.

## Debug with an agent

An agent with Paseo browser tools can open `https://app.paseo.sh`, select **Mission Control**, and inspect snapshots, screenshots, and console logs. The agent browser used for this pilot has its own host connections and currently sees only local `pc-864`; a remote host being online in the desktop client does not pair it in the browser. Check remote hosts in the desktop client or pair them separately in the browser.

After a code change, run `npm run typecheck` and `paseo plugin reload mission-control`, then reload the surface. `paseo plugin logs mission-control` shows daemon-side output. Client rendering and errors are visible in the app or browser runtime.
