# Task tracker

The backlog from 26 Sep 2026, ordered from easiest and most useful to hardest and least urgent. Each item is a Mission Control task in the dev-vault (`C:\dev-vault\Tasks\<task ID>\task.md`), where the full acceptance criteria live.

- **Build** tasks run in their own worktree and end with a handoff for you to review. Agents don't commit, push or merge.
- **Research** tasks run in the main checkout, change no repository files, and write `report.md` in the task folder.

| # | Task | Kind | Priority | Size | Task ID | State |
|---|---|---|---|---|---|---|
| 0 | How run stages and task statuses relate | Answer | High | XS | — | Answered in chat, and summarized below |
| 1 | Workspace page: own sections for terminals and linked tasks | Build | High | S | `task_2d603dfb-37b2-4fbd-9fe1-48fae96ce0d8` | Delivered: merged as `9c9ae7a`, UI checked, worktree archived |
| 2 | Workspaces tab: cleaner filters and collapsible project blocks | Build | High | M | `task_08fbb8c3-791f-4b5c-a19d-56c4635ce5f0` | Delivered: merged as `ad7d49a`, UI checked, worktree archived |
| 3 | Research: can Open agent also switch Paseo's host filter? | Research | High | S | `task_9a7f927f-053c-4e03-bf8e-e2002fed64c5` | Delivered: needs a Paseo change; call sites fixed in `d378fd8`. Proposed upstream on 28 Sep as [Discussion #5573](https://github.com/getpaseo/paseo/discussions/5573) and [PR #5574](https://github.com/getpaseo/paseo/pull/5574) |
| 4 | Rename workspaces and agents from their chat context | Build | High | M | `task_fd7ded6f-a15d-4aea-87de-b8b5c2b40776` | Delivered: merged as `01423f9`, plus fixes `a1cc347` and `b11f9d2`; Suggest, agent rename and undo checked live |
| 5 | Fresh worktrees: default branch per project and Pull latest | Build | High | M | `task_cf9bbb1f-cb23-41fa-b02c-b26f2616abf5` | Delivered: merged as `d3cbba0` and `bccb221` (round 4); Git bar checked in the app |
| 6 | Research: MCP servers, rules and skills manager | Research, then build | Medium | L | `task_6aeadd5a-80c3-4a16-92d7-c9c8d39dcabc` | Delivered: build our own read-only manager first; building needs your go-ahead |
| 7 | Research: packaging, dependency install and plugin updates | Research, then build | Medium | M | `task_6a420a37-7249-475a-9333-cf232426961f` | Delivered: releases from a tagged GitHub repo; Setup & updates page needs your go-ahead |
| 8 | Design: Dashboard tab and the task lifecycle flow | Research, then build | Medium | L | `task_ef947b9a-f16a-4830-a42e-27ba5928e26c` | In review: questions 1, 2, 6 and 12 of the report's section 7 are answered (see Decisions); the rest wait for later phases |
| 9 | Research: is autoharness worth adopting? | Research | Low | S | `task_265ee623-80be-4251-a69f-6616ca2fe1fa` | Delivered: skip autoharness, borrow four small ideas |
| 10 | Check for and apply Mission Control updates from settings | Build | Medium | S | `task_726d872d-b630-4fc7-bc02-d7d07f528cc1` | Delivered: merged as `8728ca0`; Updates screen checked in the app |
| 11 | Branch names that follow each company's format | Build | Medium | M | `task_8772d54b-0b84-4b65-bc6f-74c83a1547e9` | Delivered: merged as `db7d71f`; Branch names settings checked in the app |
| 12 | Import tasks from Jira and Azure DevOps | Research, then build | Medium | L | `task_38482084-8ea7-49b5-8ce3-cb5585384415` | Delivered: merged as `ba60fa4`; live fixture Morning check produced a report |
| 13 | Dashboard, phase 1 (default tab) | Build | High | L | `task_1a99ce9e-6821-42a0-bff1-885e96d5dfff` | Delivered: merged as `bdd1b68`; Dashboard checked in the app |
| 14 | Dashboard Merge action for finished tasks | Build | High | M | `task_04bad3a9-eda4-4acb-852d-4b5eeb438828` | Delivered: merged as `69cc457` after four review rounds (14 findings fixed, including a reviewed-files fingerprint so edits after approval can't be merged). Live, its checks refused correctly: branch moved, agent running, nothing to merge |
| 15 | MCP, rules and skills manager, phase 1 (read-only) | Build | Medium | L | `task_fe14500d-6e1d-4bc0-b4ba-5daca695f566` | Delivered: merged as `a7371d5`; Tools & skills screen checked in the app |
| 16 | Small follow-up fixes | Build | Medium | S | `task_a303a475-e705-4a67-bec4-cc5b6931ada5` | Delivered: merged as `4270cfc`; worktree start without the timeout error, one-row filters and in-place answers checked in the app |
| 17 | MCP manager, phase 2: turn servers on and off | Build | Medium | M | `task_997f6cf3-708c-4c81-bd4b-938492ffd6b8` | Delivered: merged as `7f43045` and `ba74f0c`; live Codex off-and-Undo round trips left config.toml byte-identical, with the confirmation under the clicked row |
| 18 | Small follow-ups: hidden keys in errors, one-row filters, Copilot plugins | Build | Medium | S | `task_29804a04-53dd-4004-a7fa-2d84a40ee0ed` | Delivered: merged as `64348fe`; filter rows checked at 1700 px and 1280 px |
| 19 | Replace the Dashboard with a compact Attention tab, plus Merge fixes | Build | High | M | `task_c227a35d-ad86-45ab-b4a9-3abbdbd8e262` | Delivered: the first task merged with the Merge button, as `0947002`. The merge and cleanup all worked; the old code's dialog showed a false timeout, which this task fixes. Attention tab checked in the app |
| 20 | Setup page: dependency status and safe installs | Build | Medium | M | `task_a0733e6a-aedc-49ff-bd98-f9267b3ab433` | Delivered: merged from the Attention tab as `4132e3b`, in the background, with cleanup complete. The Setup page renders, and the JSON manifest builds in Paseo |
| 21 | Deliver work tasks as draft pull requests | Build | High | L | `task_aae53259-d3aa-432a-8934-eb6ea97b7c67` | Delivered: merged by hand as `0a2c135` after the Merge button stopped cleanly at a README conflict with task 22. Five review rounds. A live test on real forges is still to do: it needs a scratch repository per forge, gh installed, and the azure-devops extension for az |
| 22 | Plain-language decision cards | Build | High | M | `task_2a613891-066b-4547-a5ce-ab4fc6cbf61d` | Delivered: merged from Attention as `ff5f7de`. Cards lead with a plain summary and recommendation; buttons say what they do; each issue gets Fix now or Skip |
| 23 | Follow paseo.json for commit messages and PR text | Build | Medium | S | `task_de2cb4a8-7899-4948-acbf-80c8f89edfa6` | Delivered: the Merge button committed the work as `62524dd`, then stopped cleanly at one conflict in review-names.tsx with task 25; merged by hand as `18371da`, keeping both sides. The retry-after-dismiss finding is a follow-up |
| 24 | Attention cards that explain themselves | Build | High | M | `task_e0ecd489-e56c-4c8d-b1cd-bc2ac65cbf53` | Delivered: the Merge button committed the work as `9eed699`, then stopped at one conflict in mission-control.tsx; merged by hand as `c7c6037` in a separate checkout, keeping master's side (task 25's roster-model.ts already records the task ID). Plugin reloads, TypeScript and related tests pass. Its reads never wake a stopped agent |
| 25 | Show sub-agents with their parent and purpose | Build | Medium | M | `task_54d298b7-7fbf-4f8d-a585-19504eb53c9b` | Delivered: merged from Attention as `3a4e090`. Sub-agents rows checked in the app on the coordinator's own card; screenshot in the guide (`914d4c4`). The review's three leftovers moved to task 26 |
| 26 | Agents panel: every agent in a workspace as a tree | Build | High | M | `task_700b9ce2-40c6-43fc-b157-aadf4f5e2263` | Delivered: the Merge button committed the work as `e292c81`, then stopped at two conflicts in review-names.tsx; merged by hand as `b57c739` (TypeScript and 390 tests pass on the merged result). Recorded questions wired into Needs input in `c70989d`. The tree renders on the Workspaces page without waking closed agents |
| — | Tasks tab opens on the board | Build | — | XS | — | Done in `62e4b7d` (the narrow workspace panel keeps the list) |
| — | User guide (standalone HTML) | Docs | — | M | — | Done: `docs/user-guide/mission-control-user-guide.html`, with 26 screenshots; rebuild with `node docs/user-guide/build-guide.mjs` |
| — | Rename the Mission tasks panel to Tasks | Build | — | XS | — | Done in `9f627b4` |

## How the requests map to tasks

- **Workspaces tab filters** and **collapsible projects** are one task (2). Both change the same list and project blocks, so two agents would collide.
- **Dashboard tab**, **overall design and lifecycle flow**, and **Workboard inspiration** are one design task (8). The dashboard is the entry point of the lifecycle flow, and both draw on paseo-plugin-helper and Workboard.
- Task 7 also covers the Obsidian CLI as a possible dependency, alongside the skills and OpenCode Review.
- Tasks 11 and 12 came from remote-host work, where tickets come from Jira or Azure DevOps and branches must follow each company's format.
- The first three research tasks (6, 7, 8) end in a recommendation. Building starts after you choose. For example, task 6 decides whether to adopt paseo-mcp or build our own.

## Agents

- Each task starts from Mission Control's launcher with **Opus 5.5 · High · Bypass**.
- If an agent hits a usage limit, it's replaced by **Codex GPT-6-Sol · High · Full Access**, which continues the same run.

## Decisions (26 Sep 2026)

- The Dashboard becomes Mission Control's first tab.
- The coordinator commits and merges finished tasks (task 14 adds a Merge action).
- The Dashboard shows this host's tasks now, and other hosts' agents and attention; other hosts' tasks come once Mission Control is installed there.
- The Paseo `focusHost` change is proposed upstream (28 Sep): [Discussion #5573](https://github.com/getpaseo/paseo/discussions/5573) and [PR #5574](https://github.com/getpaseo/paseo/pull/5574), posted as discwl from its fork with a classic `public_repo` token. Paseo closes pull requests by default, so the maintainer decides whether to take it forward.
- MCP manager phase 2 (task 17) turns servers on and off for Codex, OpenCode and Copilot. Claude Code stays read-only, and there's no delete.
- The Dashboard didn't prove useful. Task 19 replaces it with a compact Attention tab (decisions, permission prompts and Ready to merge), and Workspaces is the default tab again.
- The Setup page (task 20) may install only skill links, the OCR CLI at its pinned version, and OCR rule files. Everything else, including Gortex, shows its version and the exact command.
- Work repositories deliver through draft pull requests; personal projects keep the local Merge. Delivery is a per-host default with per-project overrides. The forges are GitHub, Azure DevOps Repos and Bitbucket Cloud. Mission Control opens PRs itself (gh, az, Bitbucket's REST API), and after a PR merges it asks before cleaning up (task 21).
- Still to come: Mission Control on the remote hosts. Releases will come from a private `discwl/development-flow` repo, like huginn. You create the empty repo, since the discwl token can't create or fork repos.
- Attention cards explain themselves (task 24, 28 Sep): agents write the summary when they stop for you; otherwise a card quotes the agent's latest message and steps. No AI summary button for now.
- Sub-agents show under their parent with a line saying whose they are and why they started (task 25, 28 Sep). Paseo's list of helpers inside a turn isn't in the plugin API, so Mission Control's server reads it directly and hides it if that fails.
- An Agents panel modelled on Agent Crew (omercnet/paseo-plugins, MIT), which the user likes: each workspace's agents as a tree with sub-agents, state filters and actions. Mission Control adds helpers inside a turn, each agent's task, and questions and decisions under Needs input, and uses the same rows on the Workspaces page (task 26, 28 Sep).

## Follow-ups

- **Morning check prompts:** the Morning check agent runs in Always Ask mode, so every run stops for permission prompts (its report script, then reading its report). Let the Morning check choose a permission mode, as Start task does.
- **Remote installs (tasks 7 and 10):** before other hosts can install from GitHub, the repo needs a remote and a Git-install build step (or no type-only `@getpaseo/client` imports). Task 4 added a runtime `@getpaseo/client` import that a Git install must also provide.
- **Tools & skills (task 15 review):** the health check keeps the URL path so servers can route it, which means a key placed in the path still reaches its own server. The screen hides it.
- **Older review decisions can't be merged:** only decisions requested after task 14 carry the reviewed-files fingerprint. Earlier ones need a fresh review request.
- **Copilot toggle Undo order (task 17):** turning the last disabled Copilot server back on removes `disabledMcpServers`, as Copilot does. Undoing that re-adds the list as the last member, so the settings match but the key order may not.
- **Setup install message (task 20 review):** if one screen follows a slow OCR install and a quick install from another window finishes before its next check, the first screen says the install "stopped reporting". The install itself succeeded. Keep the last few results on the server, not only the latest.
- **Clean up details (task 21 final review):** a branch setting added by hand (such as an upstream) stays after the branch is deleted; no test forces a commit in the instant before the delete; when a forge returns a shortened commit list, the refusal wrongly says local work would be lost; and the uncommitted-changes check looks at whichever worktree holds the branch.
- **Decision card wording (seen live on task 21):** issues fixed in earlier rounds are listed under their technical titles, because only new findings have plain descriptions; and "What each button does" says "All 1 open issue are skipped" for a single issue.
- **Decision wording checks (task 22 review):** jargon warnings reach the agent only after its decision is saved, so it can't reword that card; and a few ordinary phrases ("U.S./U.K.", "a.m./p.m.", page addresses, code-like words) are still refused. Add a check-only mode and narrow the patterns.
- **Morning check duplicate (task 19 review):** if a task's `task.md` can't be read at all (for example it's missing), the Morning import doesn't know that task's ticket, so importing it creates a second task. Treat such a file as an unknown ticket so the existing refusal names it.
- **Retry after a conflict with a written message (task 23 review):** Merge and Open PR recognize their own earlier commit of a task's work by the default message, or, for a message written from paseo.json or edited, only through the kept result card. If that card was dismissed (or dropped after 50 results, or lost on a restart mid-run), the retry asks for a fresh review instead of carrying on. It's safe, but an extra review. Record Mission Control's commits somewhere that outlives the card, such as the task's run.
- **Server bundle rule:** Paseo refuses `client/` modules in the plugin server bundle, and only a real plugin reload catches it. Reload and check for "Plugin ready" after every merge.
- **Git index writes fail now and then on this machine (29 Sep):** during task 23's merge, `git merge` and `git checkout` failed with "unable to write new index file" and worked on a retry a few seconds later, probably because another process (the Gortex indexer or Paseo's diff counts) had `.git/index` open. The Merge button's commit, merge and abort steps should retry that error a few times.
- **Reading an agent's chat wakes it (29 Sep):** Paseo restarts a stopped agent to serve its chat history. Tasks 24 and 26 stop doing it automatically; the Review names dialog still reads the chats of every agent when you ask it for suggestions, so it should skip or warn about closed agents.
- **Merge and pull-request tests fail on a busy machine:** with several agents testing at once, Git-heavy tests run past the 20-second reply window or a 1-second commit limit. Give the tests longer windows, or run those two files on their own in the workflow.
- **Error card re-read (task 24 review, skipped by the user):** if a failed agent's Conversation is open and the agent fails again within about 20 seconds, the card reads the chat once more by itself. The fix is one line: reset the card's Conversation whenever the agent fails again.
- **Last messages refresh (task 26 review, skipped by the user):** if you expand a helper's Last messages and then its parent agent stops, the open panel's next refresh (every 20 seconds, in views without live updates) can restart the parent. The fix is the same live-status check before each refresh, plus a test.

## Known constraint

Gortex can't discover task worktrees on this machine yet (v0.64.5 on Windows). Every Gortex hook call from inside a worktree holds Gortex's checkout lane, so Gortex is unavailable to other sessions while worktree agents run. It recovers about 2–3 minutes after they stop. Agents in this batch skip Gortex, as you asked on 26 Sep 2026.

## Task statuses and run stages

A task's **status** is your board position. You set it, and it never changes by itself. A **run** is one agent's attempt at the task. The agent records the run's **stage** and **outcome** as evidence.

| Task status (you) | Meaning | Typical run stage (agent) |
|---|---|---|
| Inbox | Captured, not shaped yet | none |
| Ready | Clear enough to start | none yet; Start task creates a run at Intake |
| In progress | Being worked on | Plan → Build → Checks → Review → Fixes |
| Blocked | Can't move until something outside the run changes | any stage with outcome `blocked` |
| In review | The agent handed off; you're reviewing | Handoff, outcome `completed` |
| Delivered | Accepted and merged or shipped | Delivery (only when you authorize it) |
| Closed | Finished or dropped; kept for history | none active |

A run waiting on a **Needs you** plan or review decision has outcome `waiting`. The task usually stays **In progress**.

A task can have several runs, for example after a resume or an agent swap.

Launching an agent doesn't move the task's status. A recorded stage is never an approval.
