# Paseo plugin references for Development Flow

Reviewed 19 September 2026. Purpose: select references for a future control center spanning hosts, projects, agents, human decisions, and development runs. Hermes remains on hold.

**The previous docs only covered this partially.** The older LFG build specification explicitly names Agent Monitor and Review Deck. The newer workflow-reference review concentrates on Compound Engineering, Superpowers, Factory, GSD Core, and OpenSpec. The start-here roadmap mentioned a future panel but did not identify the Paseo plugins to study. This review fills that gap.

**Scope of this review:** screened all 93 entries in the [Paseo Cafe catalog](https://paseo.cafe/), retrieved all 93 repository README snapshots at the catalog's recorded commits, and confirmed that they match the catalog's embedded README content. Examined 23 relevant candidates more closely and selected implementation paths in nine plugins. This is a source/design review, not an installation test or an audit of every line of every plugin. The inventory at the end records a recommendation for every listing.

**1. The main references, in priority order**

| Priority | Plugin | Existing behavior worth studying | What we should borrow |
|---|---|---|---|
| 1 | [Agent Monitor](https://github.com/omercnet/paseo-plugins/tree/main/agent-monitor) | One host's agent roster, project/workspace grouping, attention filters, wait age, search, and live updates | The main roster, extended with an explicit host level |
| 2 | [Agent Crew](https://github.com/omercnet/paseo-plugins/tree/main/agent-crew) | Managed agent trees, parent/child relationships, agent actions, pending permission Allow/Deny | Builder/reviewer relationships and correctly targeted agent controls |
| 3 | [agents-dash-list](https://github.com/panrafal/paseo-plugins/tree/main/agents-dash-list) | Workspace groups for waiting, unread, active, failing, approved, idle, and closed work | An attention queue that separates a question needing an answer from a result needing review |
| 4 | [Review Deck](https://github.com/mentalfl0w/review-deck) | File/diff review, anchored comments, project comment queue, and snapshot checks before reversing changes | The human review experience and source-change checks |
| 5 | [PR Radar](https://github.com/omercnet/paseo-plugins/tree/main/pr-radar) | Delivery triage based on PR checks, reviews, ownership, and active agents | Distinguish work needing Nick, work being handled, and work waiting externally |
| 6 | [Paseo GSD Observer](https://github.com/drungrin/paseo-gsd-observer) | Read-only planning/evidence board with explicit unknown, missing, and stale states | A run-details view grounded in saved evidence |
| 7 | [schedule-runs](https://github.com/panrafal/paseo-plugins/tree/main/schedule-runs) | Selected-host schedule history, run status, response, errors, and links to agents/workspaces | Morning/nightly run history and drill-down |

Agent Monitor, Agent Crew, and agents-dash-list operate within a selected host or workspace. Their existing interfaces do not provide the complete cross-host control center. Borrow their models and UI patterns, then supply host-aware identity and navigation.

Agent Crew's inspected permission handler sends a request ID with a basic Allow/Deny response. Our requested experience also needs typed question forms, plan decisions, review decisions, and evidence shown beside each decision. Those remain implementation work. [Permission handler](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/agent-crew/client/main.tsx)

Review Deck removes queued comments after the agent accepts the batch; it does not wait for verified fixes. Keep durable finding IDs and states in Development Flow, including submitted, being fixed, verified, and unresolved. Sending feedback must not mark a review complete. [Handoff implementation](https://github.com/mentalfl0w/review-deck/blob/1e5793ad2aa27651ae63ae14c9f5ae18996e427c/server/ReviewService.ts)

PR Radar's viewer identification uses the authenticated GitHub CLI. Its queue design is reusable, but Jira/ADO task intake and Bitbucket/ADO PR handling need their own adapters. [Viewer implementation](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/pr-radar/server/viewer-scope.ts)

GSD Observer expects GSD artifacts in `.planning`. Adapt its evidence-display approach to our task/handoff records; installing it does not make arbitrary Development Flow records visible. Its published manifest range is `>=0.8.0 <0.9.0`; Review Deck also declares a range below 0.9 in the reviewed snapshot. [GSD Observer requirements](https://github.com/drungrin/paseo-gsd-observer/blob/66116b167f9403e306c40a8ff1c99a55d9711768/README.md), [Review Deck requirements](https://github.com/mentalfl0w/review-deck/blob/1e5793ad2aa27651ae63ae14c9f5ae18996e427c/README.md)

**2. Helpful while building the skills-first workflow**

These are candidates to try individually on the pilot host after checking its installed Paseo version.

| Plugin | Why it helps | Important limit |
|---|---|---|
| [skills](https://github.com/gpambrozio/paseo-plugins/tree/main/skills) | Inspect discovered skills, their origins and instructions; invoke an individual stage | Claude/Codex get filesystem discovery; other providers depend on session-reported entries. Listing a skill is not proof its workflow works. |
| [task-link](https://github.com/panrafal/paseo-plugins/tree/main/task-link) | Open the ticket associated with a branch or agent title | Configure the ID pattern and destination; this links to a tracker but does not read its sprint or update tasks. |
| [paseo-markdown-viewer](https://github.com/opsb/paseo-markdown-viewer) | Read plans and handoffs beside the agent | Automatic following misses shell-heredoc writes; explicit opening remains necessary for those files. |
| [mcp-tools](https://github.com/xpufx/paseo/tree/main/plugins/mcp-tools) | Inspect MCP discovery/health and study schema-driven tool forms | Its README calls the Codex probe “provided as-is”; Claude config checks did not include a live subscription session. Use actual OCR/Gortex calls as the decisive check. |
| Agent Monitor | Observe agents during the manual pilot | Add one roster first; several overlapping dashboards can make the pilot harder to assess. |
| schedule-runs | Inspect outputs once daily schedules exist | Reads host-local schedule/workspace records; it is a history viewer, not the scheduler. |

The schedule-runs implementation relies on Paseo's on-disk records and returns a bounded history. Prefer a supported public schedule interface where the target version offers one; isolate any required file-format adapter. A successful scheduled agent turn is separate from a successfully validated development task. [Schedule runs implementation notes](https://github.com/panrafal/paseo-plugins/blob/a3758ed18157f163feede045ab3d8b723624fd23/schedule-runs/README.md)

**3. Additional references and boundaries**

| Plugin | Recommendation for this project |
|---|---|
| [paseo-beads](https://github.com/omercnet/paseo-plugins/tree/main/paseo-beads) | Borrow dependency lanes and ticket detail layout. It requires `bd` and Beads data; retain Jira/ADO as the configured tracker. |
| [workspace-activity](https://github.com/ABorakati/paseo-workspace-activity) | Study task/todo aggregation and detailed agent inspection. Its Stop implementation uses a daemon session cancellation message; prefer supported SDK operations in our implementation. Agent-emitted todos are not verified completion. |
| [paseo-ado](https://github.com/jegork/paseo-ado) | Useful ADO PR panel and work-item attachment reference. Requires `az` plus the Azure DevOps extension and authenticated access on the host. Its PR action pushes the branch when needed; adapt it to our delivery permissions. |
| [github-integration](https://github.com/alysnnix/paseo-github-integration) | A broader reference for tracker/PR details and handing an item to an agent. It uses one authenticated `gh` account and is GitHub-specific. |
| [Branch Garden](https://github.com/NaruForge/Paseo-Plugin/tree/main/plugins/branch-garden) | Strong reference for the future cleanup-candidate screen: read-only branch/worktree inspection with Windows runtime evidence. |
| [Command Deck](https://github.com/NaruForge/Paseo-Plugin/tree/main/plugins/command-deck) | Study saved, project-scoped Windows commands. It requires PowerShell 7; transient terminal output and unknown exit results do not satisfy our validation-evidence contract. |
| [Paseo Prompt Manager](https://github.com/yannelli/paseo-prompt-manager) | Optional prompt browsing/version UI. Keep one authoritative Git-backed source for shared skills; avoid separately maintained copies of their instructions. |
| [paseo-helper-demo](https://github.com/xpufx/paseo/tree/main/plugins/demo) | UI reference for tables, forms, settings, and attention indicators. Evaluate its extra helper dependency only if the official scaffold leaves a concrete gap. |
| [parent-wake](https://github.com/EPISTEX0/paseo-parent-wake) | Later reference for repeated child notifications. Its held messages are in memory and are lost on restart; our workflow state must survive that. |
| [tell-agent](https://github.com/omercnet/paseo-plugins/tree/main/tell-agent) | Small reference for target selection and messaging. It searches only the same daemon and asks the source agent to forward the message. |
| [agent-heartbeats](https://github.com/panrafal/paseo-plugins/tree/main/agent-heartbeats) | Useful optional UI for existing-agent heartbeats. Replacing a prompt/max-run setting resets that heartbeat's run history. |
| [Daemon Link](https://github.com/itsjustanks/paseo-plugin-daemon) | Later reference for dev-server access and host/process health. Linux/macOS discovery is documented; Windows forwarding is unverified. Additional pairing serves app forwarding, not agent management. |
| [top](https://github.com/xpufx/paseo/tree/main/plugins/top) | Later resource/telemetry reference. Linux is its primary tested platform, with Windows/macOS fallbacks to verify. |

The catalog contains an ADO plugin but no dedicated Jira or Bitbucket listing in this snapshot. No inspected candidate documents the complete combined requirement: cross-host sprint planning, durable workflow decisions, OCR/Gortex evidence, and controlled continuation. Those are features of our proposed plugin.

**4. What our plugin should contain**

Build a plugin called **Development Flow Control Center** after the underlying skills and run records work. Start from the official Paseo scaffold and adapt focused pieces from the references. Avoid making the product depend on private data stores or internal exports of other plugins. Retain applicable licenses and attribution for any copied code.

| View | What Nick should see and do | Main inspiration |
|---|---|---|
| Needs You | Answer questions, approve or revise plans, review results, and see exactly which run will continue | Agent Crew, agents-dash-list, PR Radar |
| Hosts & Agents | Browse host → project → workspace → agent; see offline hosts, failures, wait age, and available controls | Agent Monitor, Agent Crew |
| Runs | See current stage, acceptance criteria, validation evidence, findings, blockers, and continuation point | GSD Observer, workspace-activity |
| Review | Inspect actual changes, attach feedback, and track it through verified resolution | Review Deck |
| Daily Runs | Read morning/nightly results and open the related agent or handoff | schedule-runs |
| Work Queue | View configured tracker items, dependencies, due dates, and later sprint capacity estimates | Beads, ADO/GitHub interfaces |

A Needs You card should contain the host/project/task, the decision being requested, a short reason, relevant evidence, clear options or a text field, and the next action after the answer. Preserve plan and code revisions so an answer cannot silently approve a different plan or changed code.

Keep native provider permission requests separate from our workflow decisions in the data model. Route native responses using their actual request ID and response schema. Route plan/review decisions through the workflow's durable record. The UI can present both in one queue without confusing a tool permission with approval to ship a task.

Suggested fields to reserve while building the skills: `runId`, `hostId`, `projectId`, `workspaceId`, `agentId`, `taskId`, `stage`, `status`, `decisionId`, `decisionType`, `question`, `options`, `planRevision`, `candidateRevision`, `evidence`, `nextAction`, and timestamps. These are proposed Development Flow fields, not an existing Paseo schema. Include only the relevant fields at each stage.

**5. How the combined host view works**

The current public plugin reference documents `useHosts()` for host discovery, `getPaseoClient(serverId)` for native operations on an online paired host, and host-aware navigation. These reuse the app's existing connections; the same plugin need not be installed on each target solely for native SDK operations. Verify these APIs against the actual app/daemon versions before relying on them. [Official plugin API](https://paseo.sh/docs/plugins/reference#discover-hosts-and-target-another-host)

That client capability does not automatically expose arbitrary run files, tracker credentials, or another plugin's backend. Rich local evidence and tracker access need a supported host-side integration. Keep those bindings on their owning hosts. The dashboard should show unavailable/stale evidence explicitly when a host disconnects, and it must preserve the host ID when opening or acting on an item.

**Vault integration added to the design:** each host's Obsidian vault will hold its company/project context, persistent task/spec notes, run evidence, and dated activity/handoffs. Application profiles explicitly map to the appropriate vault scope. The control center reads these through the host-side adapter and combines them with live Paseo state. A daily note or edited status property alone does not establish current agent state, verified completion, or authorization to continue.

The proposed Obsidian companion plugin is an optional view of the same records: today's work, task/spec navigation, and stale-handoff indicators. Start with Obsidian's core views, then add UI where the pilot reveals a need. The [Obsidian vault/workflow review](obsidian-vault-workflow-review.md) covers Kepano, Obsidian Mind, Matt Pocock's skills, and the exact bridge needed between separate vault and application projects. These additions extend the proposed design; they do not change the catalog compatibility findings below.

**Excalidraw added for visual clarification:** use the existing Obsidian Excalidraw plugin for editable vault drawings and pilot yctimlin's MCP toolkit for agent creation/revision through file import/export. The future Needs You and Runs views should show a saved preview beside the related spec/plan, preserve the drawing revision, and offer host-aware navigation to the source. Treat `.excalidraw.md` as editable source and SVG/PNG as derived previews. Verify viewing and open behavior in the target Paseo versions; native MCP support alone does not establish support for an MCP App's interactive renderer. Tool selection, file-preservation findings, and the round-trip pilot are documented in the linked vault review.

**6. Build order stays skills first**

**Meeting capture extends the same records:** Talat is the selected meeting app as of 2 October 2026, and the user reports capture is working well. Its [native Obsidian integration](https://talat.app/docs/integrations/obsidian) supplies source Markdown directly to the meeting host's vault; it does not require a custom Paseo recorder or vault writer. The [meeting workflow](meeting-capture-vault-workflow.md) covers setup and source ownership. Meeting processing, project/daily links, coordinator reconciliation and proposed task intake remain planned. Later control-center views can surface recent meetings and processing gaps while the recorder operates independently of an open Paseo session. These are separate integration opportunities, not capabilities established by the Cafe catalog review.

1. Complete the one-host manual ticket and handoff pilot described in `development-flow-start-here.md`.
2. Stabilize the small run/decision records while composing LFG and daily routines.
3. Build a read-only control-center slice for one host: agent roster plus one run's evidence.
4. Add Needs You forms and prove one answer resumes the correct stage with the correct revision.
5. Connect a second host; verify host identity, disconnect/reconnect behavior, and provider-specific request forms.
6. Extend review, daily history, tracker adapters, and the remaining hosts. Add sprint estimation after task intake is trustworthy.

The first useful plugin demonstration is **one plan approval and one review decision completed from Needs You, with the correct agent continuing and the decision retained after reopening the app**.

**7. Source and compatibility notes**

The catalog homepage and separately cached detail pages sometimes showed different versions. This review uses the directly fetched catalog snapshot and its recorded repository commits; it does not treat a cached detail page as a release authority. All version values in the inventory are catalog values, not claims about the latest published package.

Some plugins support both 0.8 and the 0.9 beta line, while others cap support below 0.9. Check both app and daemon compatibility on the pilot host. Catalog health checks do not establish runtime suitability for this workflow. No plugin or schedule was installed or activated during this review.

Targeted implementation checks covered the following files. The checks examined relevant behavior, not entire-repository correctness.

| Plugin | Inspected implementation |
|---|---|
| agent-crew | [agent-crew/client/crew.ts](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/agent-crew/client/crew.ts) |
| agent-crew | [agent-crew/client/main.tsx](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/agent-crew/client/main.tsx) |
| agent-monitor | [agent-monitor/client/monitor.ts](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/agent-monitor/client/monitor.ts) |
| pr-radar | [pr-radar/client/radar.ts](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/pr-radar/client/radar.ts) |
| pr-radar | [pr-radar/server/viewer-scope.ts](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/pr-radar/server/viewer-scope.ts) |
| agents-dash-list | [agents-dash-list/shared/model.ts](https://github.com/panrafal/paseo-plugins/blob/a3758ed18157f163feede045ab3d8b723624fd23/agents-dash-list/shared/model.ts) |
| agents-dash-list | [agents-dash-list/client/directory-subscription.ts](https://github.com/panrafal/paseo-plugins/blob/a3758ed18157f163feede045ab3d8b723624fd23/agents-dash-list/client/directory-subscription.ts) |
| review-deck | [server/ReviewService.ts](https://github.com/mentalfl0w/review-deck/blob/1e5793ad2aa27651ae63ae14c9f5ae18996e427c/server/ReviewService.ts) |
| review-deck | [shared/review-handoff.ts](https://github.com/mentalfl0w/review-deck/blob/1e5793ad2aa27651ae63ae14c9f5ae18996e427c/shared/review-handoff.ts) |
| paseo-gsd-observer | [server/board-snapshot.ts](https://github.com/drungrin/paseo-gsd-observer/blob/66116b167f9403e306c40a8ff1c99a55d9711768/server/board-snapshot.ts) |
| paseo-gsd-observer | [shared/board-rpc.ts](https://github.com/drungrin/paseo-gsd-observer/blob/66116b167f9403e306c40a8ff1c99a55d9711768/shared/board-rpc.ts) |
| paseo-ado | [index.client.tsx](https://github.com/jegork/paseo-ado/blob/2e579b6ae25e5fd5846a3fb00a6f7f7fc8ad58d4/index.client.tsx) |
| paseo-ado | [server/pull-requests.ts](https://github.com/jegork/paseo-ado/blob/2e579b6ae25e5fd5846a3fb00a6f7f7fc8ad58d4/server/pull-requests.ts) |
| workspace-activity | [server/agents/control.ts](https://github.com/ABorakati/paseo-workspace-activity/blob/6fa866b82fd65a4e1073c1642bfd1c978214a96e/server/agents/control.ts) |
| workspace-activity | [client/agents/controls.tsx](https://github.com/ABorakati/paseo-workspace-activity/blob/6fa866b82fd65a4e1073c1642bfd1c978214a96e/client/agents/controls.tsx) |
| schedule-runs | [schedule-runs/index.server.ts](https://github.com/panrafal/paseo-plugins/blob/a3758ed18157f163feede045ab3d8b723624fd23/schedule-runs/index.server.ts) |

**8. Complete catalog inventory**

“Core reference” means study for our plugin. “Pilot utility” means useful to try individually during the early workflow. “Supporting” means borrow a focused pattern. “Later” means defer until that need exists. “Outside first build” means it does not materially advance the current milestone.

Each plugin link below points to the repository README snapshot actually retrieved. The catalog commit is supplied so a future implementation session can compare changes before reusing code.

| Plugin / reviewed README | Catalog version | Recommendation | Fit / limitation |
|---|---|---|---|
| [acp-manager](https://github.com/alhassanaraouf/paseo-acp-manager/blob/25197261ebf6b8d31ebdd79381237c5bce2371b5/README.md) | 0.1.0 | Later | Provider setup UI; existing Codex/Claude providers cover the pilot. |
| [agent-crew](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/agent-crew/README.md) | 0.3.0 | Core reference | Managed agent trees and request-specific Allow/Deny controls. |
| [agent-heartbeats](https://github.com/panrafal/paseo-plugins/blob/a3758ed18157f163feede045ab3d8b723624fd23/agent-heartbeats/README.md) | 0.1.0 | Supporting | Heartbeat editor; prompt/max-run replacement resets history. |
| [agent-link-9router](https://github.com/itsjustanks/paseo-plugin-9router/blob/f63923bec9feddb4a5e0994d918caf2dbb4beb24/apps/paseo/README.md) | 0.16.0 | Outside first build | Provider routing is separate from the development workflow. |
| [agent-monitor](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/agent-monitor/README.md) | 0.5.0 | Core reference | Selected-host agent roster with project grouping and attention age. |
| [agents-dash-list](https://github.com/panrafal/paseo-plugins/blob/a3758ed18157f163feede045ab3d8b723624fd23/agents-dash-list/README.md) | 0.1.0 | Core reference | Waiting/unread/work-status queue; one selected host at a time. |
| [agents-history](https://github.com/panrafal/paseo-plugins/blob/a3758ed18157f163feede045ab3d8b723624fd23/agents-history/README.md) | 0.1.0 | Supporting | History and transcript search for later recovery/navigation. |
| [agy-provider](https://github.com/3ae3ae/paseo-plugin-agy-provider/blob/95717696ffa63b472a621473baf69534298705d7/README.md) | 0.1.1 | Outside first build | Additional provider; documented system-prompt limitations matter for workflows. |
| [archive-branch-cleanup](https://github.com/MaplumeX/paseo-archive-branch-cleanup/blob/59bc5335e7cd3d5e61fc375565bb1fca9faee6da/README.md) | 0.1.0 | Outside first build | Automatic branch deletion does not fit the initial explicit cleanup flow. |
| [beam](https://github.com/maxwell-01/paseo-beam/blob/178fb37f3e7dccc5af5a6309c1fe0e4c0b46dbdb/README.md) | 0.1.0 | Later | Worktree preview swapping; adds checkout mutation outside the pilot. |
| [beautiful-chat](https://github.com/ABorakati/beautiful-chat/blob/442175dfefeff8c88f61701c385e6eb18782c142/README.md) | 0.1.0 | Outside first build | Timeline presentation, not run or decision management. |
| [branch-garden](https://github.com/NaruForge/Paseo-Plugin/blob/3f36ae10ccce4dfa8f2e79886d0d612b012f50ef/plugins/branch-garden/README.md) | 0.1.0-rc.3 | Supporting | Read-only cleanup candidates and worktree inventory; Windows reference. |
| [catppuccin-theme](https://github.com/sleeyax/paseo-plugins/blob/e06afc20d7ca1a026f5860c180269fe6eace248b/plugins/catppuccin-theme/README.md) | 0.0.0 | Outside first build | Visual theme only. |
| [chat-resume](https://github.com/panrafal/paseo-plugins/blob/a3758ed18157f163feede045ab3d8b723624fd23/chat-resume/README.md) | 0.1.0 | Later | Quota recovery and provider handover after basic handoff is reliable. |
| [colorful-agent-activity](https://github.com/mcowger/paseo-plugins/blob/471eabb10b0355b1f9becf29d36fae0b1c72b543/colorful-agent-activity/README.md) | 0.3.0 | Outside first build | Activity-row styling; avoid overlapping timeline renderers. |
| [command-deck](https://github.com/NaruForge/Paseo-Plugin/blob/3f36ae10ccce4dfa8f2e79886d0d612b012f50ef/plugins/command-deck/README.md) | 0.1.0-rc.3 | Supporting | Project-scoped PowerShell buttons; output is not durable validation evidence. |
| [commandcode-provider](https://github.com/alhassanaraouf/paseo-commandcode-provider/blob/4686178619497de780b56a563487cb59b4342e6f/README.md) | 0.1.0 | Outside first build | Additional provider, unnecessary for the selected pilot. |
| [compact-agent-activity](https://github.com/cnaron/compact-agent-activity/blob/4866482961c4c43a2f5f102fd63eadff85e15ef2/README.md) | 0.1.0 | Outside first build | Compact timeline styling. |
| [daemon-link](https://github.com/itsjustanks/paseo-plugin-daemon/blob/2d546c207dd1d1855289ea62d08a13428704e106/README.md) | 0.9.0 | Later | Dev-server links/health; Windows discovery/forwarding limitations need work. |
| [deepseek-harness](https://github.com/geoqiao/paseo-stuff/blob/a636eeafe4ffeeab7adaa61d8ab3bc3f79b467dc/plugins/deepseek-harness/README.md) | 0.1.0-beta.4 | Outside first build | Experimental provider with documented workflow capability gaps. |
| [discord-rich-presence](https://github.com/sleeyax/paseo-plugins/blob/e06afc20d7ca1a026f5860c180269fe6eace248b/plugins/discord-rich-presence/README.md) | 0.0.0 | Outside first build | Discord presence; Windows IPC unsupported. |
| [emoji](https://github.com/YoseptF/paseo-emoji/blob/425e37563234d05a3ceaf15040db221625537db9/README.md) | 0.1.0 | Outside first build | Composer convenience only. |
| [forges](https://github.com/xpufx/paseo/blob/0ae17457a644cbc325beb5a35163b5e2995b08bb/plugins/forges/README.md) | 0.1.0 | Supporting | Issue/label workflow reference for Forgejo/Gitea; different tracker. |
| [fresh-worktrees](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/fresh-worktrees/README.md) | 1.2.0 | Later | Automatic fetch/fast-forward hook; assess against explicit base-branch policy. |
| [gas-city](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/paseo-gas-city/README.md) | 0.2.0 | Later | Requires a separate Gas City supervisor and orchestration system. |
| [git-tree](https://github.com/ZFhuang/paseo-git-tree/blob/8c99642eff41e3d8d338e9181d0bcec8d86ba5d2/README.md) | 0.1.0 | Supporting | Commit/branch graph and diff navigation for a later Git view. |
| [github-board](https://github.com/gpambrozio/paseo-plugins/blob/216477edf9bce174365cf50b194c08e8d32aa4a4/github-board/README.md) | 0.6.0 | Supporting | Simple issue/PR queue; compare with PR Radar and github-integration. |
| [github-integration](https://github.com/alysnnix/paseo-github-integration/blob/d6f7184a4db16fb1be930700d1e960872caf8c2e/README.md) | 1.0.1 | Supporting | Rich tracker detail, review actions, and task-to-agent handoff; GitHub-only. |
| [gruvbox](https://github.com/juanlatorre/paseo-gruvbox/blob/4d7d73f89a434db23f9870ff37b8c24d6244b6eb/README.md) | 1.0.0 | Outside first build | Visual theme only. |
| [herald](https://github.com/gpambrozio/paseo-plugins/blob/216477edf9bce174365cf50b194c08e8d32aa4a4/herald/README.md) | 0.2.0 | Outside first build | Spoken attention alerts; documented macOS-only testing. |
| [k8s](https://github.com/jeroenfrenken/paseo-k8s/blob/be0eb6c726f32ad0fb479aa9cb8dabc29848681f/README.md) | 0.1.0 | Later | Kubernetes operational view if a project needs it. |
| [launchd-jobs](https://github.com/gpambrozio/paseo-plugins/blob/216477edf9bce174365cf50b194c08e8d32aa4a4/launchd-jobs/README.md) | 0.3.0 | Outside first build | Mac launchd scheduler; use host-appropriate Paseo daily schedules. |
| [maka](https://github.com/geoqiao/paseo-stuff/blob/a636eeafe4ffeeab7adaa61d8ab3bc3f79b467dc/plugins/maka/README.md) | 0.1.0-beta.2 | Outside first build | Experimental provider with persistence and approval gaps. |
| [math-renderer](https://github.com/geoqiao/paseo-stuff/blob/a636eeafe4ffeeab7adaa61d8ab3bc3f79b467dc/plugins/math-renderer/README.md) | 0.1.0-beta.3 | Outside first build | Math rendering does not advance workflow control. |
| [mcp-tools](https://github.com/xpufx/paseo/blob/0ae17457a644cbc325beb5a35163b5e2995b08bb/plugins/mcp-tools/README.md) | 0.1.3 | Supporting | Discovery/forms reference; Codex probe carries explicit verification limits. |
| [obol](https://github.com/broomva/obol/blob/71d563a0abf6581e761ebd79fa5bd18fb14ba8b2/README.md) | 0.0.0 | Later | Multiple subscriptions/account routing; separate from workflow correctness. |
| [opencode-session-overview](https://github.com/mcowger/paseo-plugins/blob/471eabb10b0355b1f9becf29d36fae0b1c72b543/opencode-session-overview/README.md) | 0.0.0 | Later | Useful only if OpenCode becomes a selected provider. |
| [parent-wake](https://github.com/EPISTEX0/paseo-parent-wake/blob/77c567621419af786dfd99bc6a068a6b9a42ea03/README.md) | 0.1.1 | Later | Repeat child notifications; pending messages are lost on restart. |
| [paseo-ado](https://github.com/jegork/paseo-ado/blob/2e579b6ae25e5fd5846a3fb00a6f7f7fc8ad58d4/README.md) | 0.1.0 | Supporting | ADO panel and attachments; requires working az access; PR action can push. |
| [paseo-be-concise](https://github.com/yannelli/paseo-plugin-concise/blob/0035d7359637fb379e0fc6c1ccc536c58f02bd86/README.md) | 1.0.0 | Outside first build | Prompt/context optimization tooling is not the core flow. |
| [paseo-beads](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/paseo-beads/README.md) | 0.2.0 | Supporting | Dependency lanes and task details; requires Beads data and bd. |
| [paseo-cafe](https://github.com/paseo-cafe/paseo-cafe/blob/cc83f83981b823ab9004610130b0788ba6050efb/plugin/README.md) | 0.5.0 | Pilot utility | Convenient catalog browser; optional, not a workflow dependency. |
| [paseo-defer](https://github.com/tomgrin10/paseo-defer/blob/50821f76114e45ebdc62ed3aea6531c3aef7934a/README.md) | 2.1.4 | Later | Defer an agent message; distinct from recurring daily routines. |
| [paseo-display-switcher](https://github.com/nerveband/paseo-display-switcher/blob/2d47ca7af1d672e257d1daa4909c7fbfb3e46fd8/README.md) | 0.0.0 | Outside first build | Sidebar keyboard convenience. |
| [paseo-dracula](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/paseo-dracula/README.md) | 0.3.0 | Outside first build | Visual theme only. |
| [paseo-feishu-ui](https://github.com/Laokashouji/paseo-feishu-ui/blob/99fcdd61b4bdc24e56eb5f4613bf64108c6ccc97/README.md) | 0.3.5 | Outside first build | Desktop skin with unverified Windows/Linux behavior. |
| [paseo-grafana](https://github.com/jegork/paseo-grafana/blob/d9f522ae2478e9b2492e68fde8ade8904a2534ae/README.md) | 0.1.0 | Later | Operational alert investigations if the project uses Grafana/gcx. |
| [paseo-gsd-observer](https://github.com/drungrin/paseo-gsd-observer/blob/66116b167f9403e306c40a8ff1c99a55d9711768/README.md) | 0.1.0 | Core reference | Evidence/phase board; adapt GSD-specific readers to our records. |
| [paseo-helper-demo](https://github.com/xpufx/paseo/blob/0ae17457a644cbc325beb5a35163b5e2995b08bb/plugins/demo/README.md) | 0.2.0 | Supporting | Forms, tables, attention indicators; evaluate extra helper dependency. |
| [paseo-limits](https://github.com/ortschun/paseo-limits/blob/4c92092a1f42a39b84bc2c286c87901f436bd489/README.md) | 0.1.1 | Later | Subscription availability display after the workflow is proven. |
| [paseo-markdown-viewer](https://github.com/opsb/paseo-markdown-viewer/blob/9a19dfe2837c7e4a510ed767fa89c920c3ad4195/README.md) | 0.1.0 | Pilot utility | Read task plans and handoffs beside the agent. |
| [paseo-mcp](https://github.com/itsjustanks/paseo-mcp/blob/5afc36ffc78e7ae978f45e99a38be26efc447b48/README.md) | 0.7.0 | Later | Broader MCP configuration/credential management; avoid a second configuration authority. |
| [paseo-omp](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/paseo-omp/README.md) | 0.3.0 | Outside first build | Additional agent runtime/provider; not needed for this pilot. |
| [paseo-plain](https://github.com/scowalt/paseo-plain/blob/1183b9322d34ddd6bf35f048eaa71661affd12f9/README.md) | 0.2.0 | Outside first build | Optional answer simplification, not workflow execution. |
| [paseo-prometheus-status](https://github.com/infectiousstupidity/paseo-prometheus-status/blob/6722d00766a7be7e6cfeaac7b867a05e4c72e596/README.md) | 0.1.0 | Later | GPU telemetry only where Prometheus already exists. |
| [paseo-prompt-manager](https://github.com/yannelli/paseo-prompt-manager/blob/1f6c6415f77f3d48c71e3ad7438345d4f7c91f7d/README.md) | 0.2.0 | Supporting | Prompt browsing/history; preserve one source for shared skills. |
| [pi-plugin-mcowger](https://github.com/mcowger/paseo-plugins/blob/471eabb10b0355b1f9becf29d36fae0b1c72b543/pi-plugin-mcowger/README.md) | 0.2.0 | Outside first build | Additional Pi provider. |
| [pi-tasks-timeline](https://github.com/mcowger/paseo-plugins/blob/471eabb10b0355b1f9becf29d36fae0b1c72b543/pi-tasks-timeline/README.md) | 0.0.0 | Outside first build | Pi-specific todo rendering. |
| [plugin-updates](https://github.com/xpufx/paseo/blob/0ae17457a644cbc325beb5a35163b5e2995b08bb/plugins/plugin-updates/README.md) | 0.1.0 | Later | Plugin update visibility once the selected installation set is stable. |
| [pr-radar](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/pr-radar/README.md) | 0.4.0 | Core reference | Delivery attention queue; GitHub viewer adapter needs replacement for other forges. |
| [pr-views](https://github.com/pmusaraj/paseo-pr-views/blob/d909376ee467576d2afa714966967efc59f8b188/README.md) | 0.1.0 | Supporting | Saved GitHub review filters; narrower than the proposed delivery queue. |
| [prompt-palette](https://github.com/NaruForge/Paseo-Plugin/blob/3f36ae10ccce4dfa8f2e79886d0d612b012f50ef/plugins/prompt-palette/README.md) | 0.1.0-rc.3 | Supporting | Reusable prompt-selection UI; shared skills remain authoritative. |
| [provider-usage](https://github.com/nerveband/paseo-provider-usage/blob/b4e1b65ec6bd6c11b191193df27653d9324d8f3e/README.md) | 0.3.0 | Later | Quota overview; select one usage surface when needed. |
| [readable-agent-activity](https://github.com/geoqiao/paseo-stuff/blob/a636eeafe4ffeeab7adaa61d8ab3bc3f79b467dc/plugins/agent-activity/README.md) | 0.1.0-beta.7 | Outside first build | Activity rendering with version/detail-mode constraints. |
| [reasoning-display](https://github.com/mcowger/paseo-plugins/blob/471eabb10b0355b1f9becf29d36fae0b1c72b543/reasoning-display/README.md) | 0.0.0 | Outside first build | Reasoning-row presentation only. |
| [remote-editor](https://github.com/alhassanaraouf/paseo-remote-editor/blob/56bc4056630ebd766395ba3e71c6d92268e95f59/README.md) | 0.1.0 | Supporting | Open the selected remote workspace in an editor over SSH. |
| [review-deck](https://github.com/mentalfl0w/review-deck/blob/1e5793ad2aa27651ae63ae14c9f5ae18996e427c/README.md) | 1.1.0 | Core reference | Diff/comments UX; queue submission does not verify fixes. |
| [runtime-radar](https://github.com/jegork/paseo-runtime-radar/blob/e427e8cd349c648a13b1a9e0c93e8cae15c08761/README.md) | 0.1.0 | Later | Ports/containers view requires lsof; not a direct Windows baseline. |
| [sayr](https://github.com/dorasto/sayr/blob/8710e7df54b0ac2765974373c8ca96b4c068ab24/packages/paseo-plugin/README.md) | 0.1.0 | Outside first build | Separate task service/account, outside configured Jira/ADO intake. |
| [schedule-runs](https://github.com/panrafal/paseo-plugins/blob/a3758ed18157f163feede045ab3d8b723624fd23/schedule-runs/README.md) | 0.1.0 | Core reference | Daily run outputs/history; isolate host-file-format dependencies. |
| [send-to-paseo](https://github.com/tomgrin10/send-to-paseo/blob/59be3b4d8e82c90bd8740bf1fd99fe351c32478a/plugin/README.md) | 1.1.0 | Later | PR-to-agent browser handoff; requires companion browser extension for full use. |
| [session-summary](https://github.com/mcowger/paseo-plugins/blob/471eabb10b0355b1f9becf29d36fae0b1c72b543/session-summary/README.md) | 0.0.0 | Supporting | Compact task/tool/session summary; timeline evidence can be incomplete. |
| [session-usage](https://github.com/panrafal/paseo-plugins/blob/a3758ed18157f163feede045ab3d8b723624fd23/session-usage/README.md) | 0.1.0 | Later | Usage history/estimates; does not query actual provider billing. |
| [setup-monitor](https://github.com/stevecastaneda/paseo-plugins/blob/9a386623ae36a525bd4690445ebf39ef2c2fa471/setup-monitor/README.md) | 0.1.1 | Pilot utility | Visible worktree setup progress and failure context. |
| [shared-browser](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/paseo-shared-browser/README.md) | 0.4.0 | Later | Shared Chromium for browser-heavy validation; additional runtime/download. |
| [skills](https://github.com/gpambrozio/paseo-plugins/blob/216477edf9bce174365cf50b194c08e8d32aa4a4/skills/README.md) | 0.1.1 | Pilot utility | Inspect and invoke shared skills; useful before writing LFG. |
| [slash](https://github.com/xpufx/paseo/blob/0ae17457a644cbc325beb5a35163b5e2995b08bb/plugins/slash/README.md) | 0.1.0 | Supporting | Discoverable workflow commands and command-selection UX. |
| [smart-session](https://github.com/tomgrin10/paseo-smart-session/blob/ad271c769109d69a1261a79f2fa277b880b0575f/README.md) | 1.2.0 | Later | Provider/context management after durable task handoff exists. |
| [subagent-activity](https://github.com/mcowger/paseo-plugins/blob/471eabb10b0355b1f9becf29d36fae0b1c72b543/subagent-activity/README.md) | 0.0.0 | Supporting | Detailed descendant activity; native-provider visibility is best effort. |
| [task-link](https://github.com/panrafal/paseo-plugins/blob/a3758ed18157f163feede045ab3d8b723624fd23/task-link/README.md) | 0.1.0 | Pilot utility | Configured ticket shortcut; no tracker read/write integration. |
| [tell-agent](https://github.com/omercnet/paseo-plugins/blob/13f076d6235c33b543193cbe90e7ab0d887a996c/tell-agent/README.md) | 0.3.0 | Supporting | Target matching/message handoff; same host only. |
| [tidy-timeline](https://github.com/jegork/paseo-tidy-timeline/blob/1583e6292e2a29072c26c07870dc5db2badf115b/README.md) | 0.2.2 | Outside first build | Noise reduction in timeline rows. |
| [time-since](https://github.com/stevecastaneda/paseo-plugins/blob/9a386623ae36a525bd4690445ebf39ef2c2fa471/time-since/README.md) | 0.1.1 | Supporting | Small elapsed-time UI pattern; activity time is not task progress. |
| [title-style](https://github.com/zwmmm/title-style/blob/73b3f8813a26d26c38dfc76516f57b16bb7d2d5f/README.md) | 1.3.0 | Outside first build | Workspace naming customization. |
| [top](https://github.com/xpufx/paseo/blob/0ae17457a644cbc325beb5a35163b5e2995b08bb/plugins/top/README.md) | 0.4.0 | Later | Host telemetry; Linux primary testing and Windows fallback to verify. |
| [turn-changes](https://github.com/Laokashouji/paseo-turn-changes/blob/47b011d02fd04b963438fb24b19ad5e46734b687/README.md) | 0.1.5 | Later | Turn-level diffs/undo; Linux listing and edit-record coverage limits. |
| [usage-monitor](https://github.com/ABorakati/paseo-usage-monitor/blob/40ac2994e529f735c1965b0ecac4247ee125e288/README.md) | 0.1.0 | Later | Provider quota history; assess local credential access before selection. |
| [usage-sidebar](https://github.com/RUIIIOVO/paseo-usage-sidebar/blob/e9c5c2d0a824fa333b091fd2f9e27bf36efe8139/README.md) | 1.0.1 | Later | Native Paseo usage display; preferable to duplicate polling where sufficient. |
| [video-embeds](https://github.com/kschniedergers/paseo-plugins/blob/da91d9b635afbd60211c66a71c0b9c06b72b828e/video-embeds/README.md) | 0.1.0 | Outside first build | Media rendering rather than workflow control. |
| [vscode-open-remote](https://github.com/panrafal/paseo-plugins/blob/a3758ed18157f163feede045ab3d8b723624fd23/vscode-open-remote/README.md) | 0.1.0 | Supporting | Remote workspace navigation; tablet tunnel setup is separate. |
| [workspace-activity](https://github.com/ABorakati/paseo-workspace-activity/blob/6fa866b82fd65a4e1073c1642bfd1c978214a96e/README.md) | 0.1.0 | Supporting | Agent/todo drill-down; adapt cancellation via supported host APIs. |
| [workspace-links](https://github.com/stevecastaneda/paseo-plugins/blob/9a386623ae36a525bd4690445ebf39ef2c2fa471/workspace-links/README.md) | 0.2.2 | Supporting | Workspace resource links; existing behavior opens on daemon host. |
| [zcode-provider](https://github.com/supermomonga/paseo-plugin-zcode-provider/blob/a4e1c1ee0bfbe914ff18eb7bb9eba62170551260/README.md) | 0.1.0 | Outside first build | Additional unofficial provider integration. |
