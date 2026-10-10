# Development flow: start here

19 September 2026 • Updated 25 September 2026 for Mission Control

**Create a project called `development-flow` on your main PC. First, build a small installable Mission Control plugin so you can test a host-first view in Paseo; then prove one development workflow on one real application repository and pilot Host Brain vault.** Keep Hermes on hold. Exercise a second connected host early for plugin navigation, and roll the full workflow out to other hosts after the pilot works.

This document provides the starting order and an index to the existing material. The accompanying ZIP contains this roadmap, the Mission Control specification and UI concepts, the Paseo plugin review, the Obsidian vault/workflow review, the meeting-capture plan, and ten original files preserved unchanged. The kit began as a plan; its first plugin, vault pilot, and individual workflow skills are now implemented on `personal`. Schedules remain inactive. You have separately explored Agent Crew and Agent Monitor in Paseo.

**Pilot status (23 September 2026):** `plugins/mission-control/` is installed in Paseo on `personal`; `C:\\dev-vault` is the linked Host Brain and Paseo project; nine individual skills are available to fresh Codex agents; `scripts/dev-flow.mjs` binds one assigned task and writes runs, stage events, and handoffs. The pilot task `task_264d8373-7966-46ee-a208-659751e753bc` is delivered after an agent plan, implementation guide, validation, independent review, fixes, and completed handoff. Mission Control displays its latest run and read-only evidence in Docs. The final plugin typecheck passed, bridge CLI tests passed 2/2, and the concurrent-writer test passed 1/1. See [the agent workflow guide](docs/agent-workflow.md) for the current command path, evidence, and limits. At that checkpoint, remote-host desktop validation and the one-click task launcher remained subsequent work.

**Current status (25 September 2026):** The first local Git baseline is commit `4884074`. Mission Control now has Start/Resume for linked tasks, host/project/workspace task counts and filters, a task list and board, and an editable dev-vault Docs browser. The personal-host vault has nine linked tasks: six delivered, two closed, and one status-label task blocked on Paseo's public label-editing API. Native Paseo workspace labels now appear as badges and filter workspaces alongside project, search, and task filters. Label assignment still requires Paseo's native workspace menu because the public plugin SDK does not expose label editing. The plugin typecheck and all 38 tests pass with `node --experimental-strip-types --test` on the current Node 22 runtime. The pilot proves task dispatch and resume in this repository; the full flow has not yet been exercised in a separate application repository. A remote host appears in the cross-host roster, but its desktop task flow and host-local vault adapter have not been verified. Next are a native label-editing API integration when Paseo exposes it, the Mission Control Review names control, and durable plan/review decisions, followed by tracker delivery/cleanup and schedules.

**Each host will also have a Host Brain project: an Obsidian vault for company/project context, specs, tasks, run evidence, and daily handoffs.** The shared workflow must explicitly connect each application profile to that vault. Daily notes organize history; persistent project/task records carry the latest plan and continuation point.

**Excalidraw joins the design flow:** use the Obsidian Excalidraw plugin to view/edit drawings in the vault and pilot an Excalidraw MCP toolkit for agent-created visuals. Save editable diagrams alongside the related feature and link them from specs, plans, and handoffs.

**Meeting capture becomes another source of project context:** capture Teams/Zoom audio on the host attending the call, then save titled transcripts and meeting notes into its vault. Meetily Pro is the preferred recorder and first pilot, as decided on 19 September 2026; OpenWhispr remains a fallback. See the dedicated plan for the local API integration and host checks required before unattended use.

**1. Which documents to use**

| Document in this kit | How to use it |
|---|---|
| `development-flow-start-here.md` | Read first. Use this proposed build order and scope when starting the project. |
| `docs/agent-workflow.md` | Current personal-host task dispatch, skills, run evidence, validation, review, and resume instructions. |
| `docs/mission-control-plugin-spec.md` and `docs/mission-control/mockups/` | Current Mission Control UI, agent/task/delivery/cleanup model, SDK boundaries, and the first installable slice; use the PNGs as design concepts. |
| `docs/source-notes/development-flow-notes.md` | Main requirements: individual skills, task flow, host/project context, permissions, morning/nightly behavior. |
| `docs/source-notes/workflow-reference-review.md` | Design references: what to borrow from Compound Engineering, Superpowers, Factory, GSD Core, OpenSpec, and others. |
| `docs/paseo-plugin-reference-review.md` | Dated review of Paseo Cafe listings and plugin patterns. Use with the newer Mission Control spec when building the plugin now. |
| `docs/obsidian-vault-workflow-review.md` | Read alongside this roadmap. Research on Kepano, Obsidian Mind, Matt Pocock, and Excalidraw; the per-host vault layout, application bridge, daily records, editable-diagram exchange, and pilot. |
| `docs/meeting-capture-vault-workflow.md` | Meeting recorder comparison, automatic-start limitations, local adapter, titled transcript/note layout, and Teams/Zoom acceptance checks. |
| `docs/ocr-kit/research-report.md` | Technical background for OCR delegation, Paseo, Gortex, and subscription-backed review. Consult when integrating review. |
| `docs/ocr-kit/windows-setup.md` | Starting checklist for the review tools on Windows. Verify the actual installed versions and runtime before applying its commands. |
| `docs/ocr-kit/reviewer-prompt.md` | Starting instructions for a fresh reviewer. Adapt its default base branch to the project and supply the task’s acceptance criteria. |
| `docs/ocr-kit/csharp-dotnet.md` | Review rules for C#/.NET projects. Use where the stack applies. |
| `docs/ocr-kit/global-rule.json` | Example OCR rule configuration. Merge the relevant settings with existing configuration. |
| `docs/ocr-kit/review-output.schema.json` | Proposed structured review-result format. It is our contract, not a guarantee of OCR’s native output. Automate validation when composing the flow. |
| `docs/archive/lfg-build-specification.md` | Older plugin/controller/database design. Retain its useful ideas for future UI and execution controls; do not use its architecture as the first milestone. |
| `docs/archive/lfg-gortex-skills-audit.md` | Older technical audit. Consult for Gortex context and review pitfalls, then verify current APIs. Its controller-first assumptions are also historical. |

The older LFG specification starts with a plugin and database. The later development-flow notes choose shared skills and small local records for workflow execution. This revision brings forward a **thin read-only Paseo plugin** to test navigation and layout while keeping the Host Brain records and reusable skills as the source of workflow truth. User decisions and host permissions still govern execution; a document does not grant new permissions. Older version pins and commands are research snapshots, not instructions to downgrade working installations.

**2. What the new project contains**

On Windows, a reasonable location is `C:\dev\development-flow`. If your agents run in WSL, use a location appropriate to that runtime. Keep tool installation, paths, and the account running Paseo consistent.

Extract the kit there, initialize Git, and open that folder as a project in your editor/Paseo. This is where you develop and version the reusable workflow. Actual product code continues to live in its own application repository.

Create a separate Host Brain vault on the pilot host, for example `C:\vaults\host-main-brain`, and open it in both Obsidian and Paseo. Keep the application as its own project. Its profile points to the vault and the relevant company/project notes; opening the vault as a Paseo project alone does not load that context into application agents.

| Location | Purpose | When |
|---|---|---|
| Root roadmap, `docs/`, and Mission Control mockups | Starting instructions, product specification, and supporting references | Included now |
| `plugins/mission-control/` | Installable Paseo plugin source with client surface and later host adapter | First implementation session |
| `skills/` | Individually callable steps and, later, the LFG coordinator | Create during implementation |
| `templates/` | Common project, task, plan, run, review, handoff, and daily-note formats | First implementation session |
| `profiles/examples/` | Examples of host and project settings | First implementation session |
| `scripts/` | Small helpers for repeated checks, state handling, or installing shared skills | Add when needed |

Real host paths and credentials stay in appropriate host/project configuration; private ticket/run notes belong in the owning host's vault. Keep credential references in profiles and secrets in the existing credential system. Add Git exclusions before saving private local configuration. Share the reusable workflow across hosts without copying one host’s private work into another.

A folder named `skills/` will not automatically make skills available to every provider. Verify how the selected provider loads skills, then install or link the versioned skills into its supported location. Confirm a fresh session can actually find them. When testing the workflow on a ticket, run it in the **application workspace** with that project’s profile.

**3. Build in this order**

| Step | Build or prove | Finished when |
|---|---|---|
| 1. Select pilot and contract | Pick a main host, second connected host for UI testing, pilot repository/vault, provider, tracker, modest ticket, and stable host/project/workspace IDs | Pilot profile identifies the vault and project scope; installed Paseo app/daemon and plugin SDK capabilities are verified |
| 2. **Ship Mission Control slice 1** | Scaffold an installable plugin with sidebar entry, host-first surface, workspace/agent rows, managed lineage when exposed, direct navigation, and offline state | Two hosts are visible, correct rows open, restart/reload works; no workspaces, agents, or Git state are mutated |
| 3. Link one real task | Create a manual task record in the pilot Host Brain vault, link its workspace/agents, and show basic status in a workspace panel | IDs and task links persist after restart; the UI distinguishes facts, stale observations, and unknown values |
| 4. Check tools and run one ticket manually | Prove OCR/Gortex on a known change; implement individual skills and pass one task record between them | Actual checks and independent review are recorded; a fresh application session resumes from its vault handoff |
| 5. Add LFG and decisions | Compose the proven steps; add structured Needs You cards and bounded approvals | Coordinator advances by evidence and stops on blockers or exhausted repair budget; decisions survive reopening |
| 6. Add tracker/delivery/cleanup | Import tasks with deduplication, track commits/PR/merge/verification separately, surface cleanup candidates | A merged branch remains visible until linked tasks and workspace safety checks are resolved; no automatic archive on idle/merge |
| 7. Add morning/nightly routines | Run manually, then schedule on the pilot host, with host-local profiles and durable handoffs | Fresh sessions reconcile state without duplicate tasks/workspaces; nightly records an honest checkpoint |
| 8. Expand host adapters | Exercise another vault and tracker and then the remaining hosts | Host differences are profiles or narrow adapters, not copied workflow logic |

The early plugin is deliberately useful before LFG exists: you can test host/workspace/agent navigation in your current Paseo installation. It does not substitute for the real task record, review process, and authorization gates. See [Mission Control specification](docs/mission-control-plugin-spec.md) for the UI, data model, and acceptance checks. Add on-demand AI workspace briefs and richer orchestrator mission views once reliable run and task evidence is available.

Run the meeting-capture pilot alongside this sequence once the vault exists: prove both sides of one Teams and one Zoom call, implement `ingest-meeting` and durable filing, then prove automatic detection/start/stop. Begin on the main PC where calls occur; meeting capture is not a prerequisite for completing the first development ticket. [Meeting-capture plan](docs/meeting-capture-vault-workflow.md)

**4. The first implementation session**

Start by reading this roadmap, the [Mission Control spec](docs/mission-control-plugin-spec.md), and the two files in `docs/source-notes/`. Select an existing application and a small ticket so you can judge the workflow against real work. Confirm the actual Paseo version on the main and second host. Use `paseo plugin init` to scaffold `plugins/mission-control/`, typecheck its generated plugin, and install it locally on the main daemon for the first host-first surface. Inspect supported host, workspace, agent, parent, and navigation fields on that installed version; wire in the read-only roster and an offline-host case. The official [plugin quickstart](https://paseo.sh/docs/plugins) and [reference](https://paseo.sh/docs/plugins/reference) describe this API, subject to version verification.

Create a project profile with the repository/worktree, vault root, host/company/project identity, allowed context/write locations, timezone, tracker project and account, base branch, stack, existing build/test/lint commands, relevant business documents, and allowed actions. Verify these values on the host instead of filling them with guessed defaults.

Create a compact task template: source ID/link, intended behavior, observable acceptance criteria, non-goals, business-rule references, and open questions. Create a handoff template that records task identity, stage, Git revision and uncommitted state, checks actually run, review status, approvals, blockers, and the exact next action.

For one feature that benefits from a visual, try the selected [Obsidian Excalidraw plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin) and [yctimlin's Excalidraw MCP toolkit](https://github.com/yctimlin/mcp_excalidraw). Prove that an agent-generated `.excalidraw.md` drawing opens in Obsidian, a human edit survives re-import/revision, and the drawing is linked to its spec. The toolkit uses a separate local canvas and file exchange. Its current exporter replaces the Markdown wrapper, so preserve custom prose/properties through our save helper or keep them in the adjacent spec. See the source findings in the vault review.

After the navigator works, build the minimal task record and the basic workspace status panel. Then build `check-environment` and `write-handoff`, with small shared `load-context` and `record-progress` helpers. They should verify the selected vault scope, load the project/task pointers, save separate run events, and write a resumable handoff. Use the existing review kit for the first review smoke test. A failure to access a tool should produce a useful blocker report, not a claim that review passed.

Keep one canonical run state in the vault, initially Markdown with typed frontmatter. A human-readable handoff, daily summary, and any later JSON should reference or represent that same state. On resume, compare it with current Git and tracker state; a saved note can be stale. Give one coordinator ownership of the daily roll-up and run summary so parallel agents cannot overwrite each other's work.

Reserve stable host, project, workspace, agent, task, run, and decision identifiers. Record the stage, requested decision, relevant plan/code revision, evidence, and next action. These small records will let a future control-center UI display and answer requests without reconstructing them from chat.

**5. The manual development flow**

Implement these as individual skills, keeping each useful on its own:

| Stage | Expected result |
|---|---|
| `check-environment` → `intake-task` | Confirm the selected project and convert the ticket into the common task record |
| `plan-task` | Small implementation plan based on existing patterns, with validation and explicit non-goals |
| `clarify-with-diagram` when useful during discovery/planning | An editable Excalidraw feature flow, architecture sketch, or dependency map; resolved decisions written into the linked spec |
| Plan decision | Approval covering the proposed scope; retain already granted approval within that scope |
| `execute-task` → `simplify-changes` | Implement the approved change; simplify only where useful within that change |
| `validate-changes` | Actual results from the relevant existing checks, tied to the code tested |
| `review-changes` | Fresh reviewer assesses requirements and code quality, with OCR delegation and Gortex context |
| `fix-findings` | Investigate findings, fix substantiated issues, validate, and obtain review of the revised change; initially allow at most two repair rounds |
| Review decision → `prepare-delivery` | Present the reviewed result and proposed commit/PR/tracker actions; execute only authorized actions |
| `write-handoff` | Save progress and an exact continuation point; retain useful, verified lessons when there is something worth reusing |

Start with one Builder and a fresh Reviewer, with one writer to the application workspace. Pause changes while the reviewer examines that workspace. OCR delegation supplies review selection and rules; the host agent performs the reasoning. Gortex helps investigate repository context. See the included research report and [OCR source](https://github.com/alibaba/open-code-review).

Review the actual candidate. A committed-branch comparison can miss pending edits; a workspace-only review can omit earlier commits belonging to the same ticket. Record the full intended scope and resolved revisions. If a candidate commit is necessary before review, include that local commit in the approved execution scope. Changes after review require refreshed evidence for the affected scope.

Keep plan and final-review gates initially. A bounded approval can cover implementation and validation without repeated questions. Commit, push, PR creation, tracker writes, merge, and cleanup retain their applicable authorization boundaries. `cleanup-workspace` comes after the core workflow is proven.

**6. Where your references fit**

These are patterns to adapt into one workflow. Native compatibility of the combined stack still needs the pilot test.

| Reference | What to borrow | Where it belongs |
|---|---|---|
| [Compound Engineering](https://github.com/EveryInc/compound-engineering-plugin) | Reusable planning/build/review skills, LFG composition, and selective learning from completed work | Overall structure |
| [Superpowers](https://github.com/obra/superpowers) | Clear implementation steps, requirements review, evidence before completion, and investigation of feedback | Plan, build, validate, review, fix |
| [Addy Osmani’s Factory](https://github.com/addyosmani/factory) | Explicit scope, bounded work, task ownership, and stop conditions | LFG limits and scheduled runs |
| [GSD Core](https://github.com/open-gsd/gsd-core) | Durable pause/resume records reconciled with the current checkout | Handoff and morning recovery |
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) | Established business requirements and proposed changes kept explicit | Project context and ticket criteria |
| [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) | Planning scaled to the work: brief, requirements, architecture, and stories when needed | New-idea entry point before ticket execution |
| [Kepano's Obsidian skills](https://github.com/kepano/obsidian-skills) | Correct Markdown/properties, Bases views, and optional template rendering | Vault records and navigation |
| [Obsidian Mind](https://github.com/breferrari/obsidian-mind) | Bounded session context, standup, wrap-up, and linked knowledge maintenance | Context loading and daily lifecycle, adapted to application workspaces |
| [Matt Pocock's skills](https://github.com/mattpocock/skills) | Domain clarification, specs, ticket slices, bug diagnosis, review dimensions, and concise handoffs | Selected practices inside our existing stages |
| [Obsidian Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin) + [Excalidraw MCP toolkit](https://github.com/yctimlin/mcp_excalidraw) | Editable visual discussions, diagram inspection, and vault-file import/export | Clarify features and designs; attach visuals to plans and handoffs |

The reference review also covers Finn-loop’s small task contracts and revision-specific review evidence, Planning with Files, Spec Kit, and the other repositories previously collected. Consult those as a particular implementation problem arises.

Do not invoke upstream Compound Engineering LFG unchanged: its documented flow can include committing, pushing, and opening a PR. Our coordinator must preserve the selected delivery permissions and OCR review path. [Upstream LFG](https://github.com/EveryInc/compound-engineering-plugin/blob/main/skills/lfg/SKILL.md)

For an existing ticket, start at intake. For a new application idea, add the planning work needed to produce an implementation-ready story first, using BMAD as a reference. Both routes should feed the same task format and execution flow. A small change does not need every planning artifact. [BMAD planning paths](https://docs.bmad-method.org/plan/choose-a-planning-path/)

The Obsidian review identifies the exact Matt Pocock skills to adapt. Change their temporary handoff/local-ticket paths to our durable records, supply Jira/ADO adapters where needed, preserve our delivery permissions, and review uncommitted candidate changes. Use one lifecycle implementation; installing several complete second-brain frameworks would duplicate session and maintenance behavior.

**7. Morning and nightly schedules**

Keep these on each host, using the shared skills and that host’s profiles. The main PC is where you develop the workflow and coordinate work; it need not launch every routine on every machine.

Paseo schedules start a fresh agent on each run, which makes durable handoffs necessary. A heartbeat instead revisits an existing agent. Use schedules for the daily routines after manual trials. Set the timezone explicitly, select the correct workspace/provider, and inspect a run-once result before relying on recurring execution. [Schedule behavior](https://paseo.sh/docs/schedules), [schedule CLI](https://paseo.sh/docs/schedules-cli)

Morning: load the profile, check current state and task ownership, reconcile the handoff, and propose the next work or resume work already authorized. Nightly: request a safe checkpoint, record actual work and checks, and save the next action. If a builder is still changing files, report that limitation rather than recording a false completed checkpoint.

Include unresolved meeting commitments in morning context, and link captured meetings plus pending/failed processing in the nightly roll-up. The local recorder runs independently of these schedules. Meeting-derived actions enter the same intake and authorization flow as other proposed work.

Save the morning focus and nightly roll-up in `Daily/YYYY/MM/YYYY-MM-DD.md`, linking persistent project/task notes and `Runs/<run-id>/` evidence. Group events using the host's configured timezone. The baseline uses vault files directly, so Obsidian need not remain open; its CLI and in-app API are optional integrations. [Obsidian CLI requirement](https://help.obsidian.md/cli)

Implement duplicate-run prevention before enabling recurring execution. Decide how that host handles missed triggers and sleep/offline time; do not assume automatic catch-up behavior. Confirm the selected host’s daemon and provider can run unattended.

**8. Paseo plugin references and Mission Control**

The earlier LFG specification names Agent Monitor and Review Deck. The new [plugin reference review](docs/paseo-plugin-reference-review.md) expands that into a current catalog review and a concrete design map.

| Reference | What to borrow for our plugin |
|---|---|
| [Agent Monitor](https://github.com/omercnet/paseo-plugins/tree/main/agent-monitor) | Agent roster and project/workspace grouping, extended with a host level |
| [Agent Crew](https://github.com/omercnet/paseo-plugins/tree/main/agent-crew) | Managed agent trees, targeted controls, and pending permission handling |
| [agents-dash-list](https://github.com/panrafal/paseo-plugins/tree/main/agents-dash-list) | Separate waiting questions, unread results, failures, and active work |
| [Review Deck](https://github.com/mentalfl0w/review-deck) | Diff navigation and anchored human feedback |
| [PR Radar](https://github.com/omercnet/paseo-plugins/tree/main/pr-radar) | Delivery triage and ownership-aware attention queues |
| [GSD Observer](https://github.com/drungrin/paseo-gsd-observer) | Evidence-based run/phase details with explicit missing or stale state |
| [schedule-runs](https://github.com/panrafal/paseo-plugins/tree/main/schedule-runs) | Morning/nightly run history and output drill-down |

During the pilot, consider the `skills` plugin to inspect/invoke stages, `task-link` for ticket navigation, and a Markdown viewer for plans and handoffs. The detailed review explains conditional references such as `paseo-ado`, Beads, workspace-activity, Command Deck, and Daemon Link. Use [Tell Agent](https://paseo.cafe/plugins/tell-agent/) and [Paseo Defer](https://github.com/tomgrin10/paseo-defer) as patterns for chat slash commands, composer pills, full surfaces, and scoped, durable actions; their behavior does not itself create our task system.

Build **Mission Control** in layers. The first plugin release is a host-first navigator with agent lineage and accurate online/offline states. With the task/run records in place, extend its full view with Needs You, Missions, Tasks, Delivery, and Cleanup; provide workspace status on demand, then add chat entry points for task and mission commands. The first decision slice should let you answer one plan and one review decision, resume the correct agent, and retain the answer after reopening the app. The two included UI concepts show the proposed fleet and task views.

Use public Paseo APIs for cross-host agent access and navigation, and verify support on the actual app/daemon versions. Native cross-host operations do not automatically expose host-local workflow files; rich run evidence needs a scoped host-side integration. [Plugin API](https://paseo.sh/docs/plugins/reference#discover-hosts-and-target-another-host). [Paseo plugin helper](https://github.com/xpufx/paseo-plugin-helper) is an archived developer library moved into the Paseo monorepo; use the official scaffold first and only adopt a helper version verified against the installed SDK.

Keep workflow decisions and verified finding resolution in our own records. Review Deck's submission queue and an agent's attention status are useful UI inputs, but neither establishes that a task has passed validation and review. Preserve Compound Engineering and Superpowers as the workflow references alongside these plugin UI references.

Use the vault's records as Mission Control's durable context/evidence source, with a scoped host-side adapter for remote access. An optional Obsidian companion can later add task navigation and daily-work views over the same records. Begin with core Daily notes, Templates, and Bases plus the selected Excalidraw plugin. Mission Control can display diagram previews beside plans and questions after the first task flow exists. See [the vault integration review](docs/obsidian-vault-workflow-review.md).

**First plugin success target:** install Mission Control locally on the main Paseo daemon and use its sidebar view to inspect two hosts, open the correct workspace/agent, distinguish a managed child from an independently assigned mission agent, and keep an offline host visible without implying current activity. The first release does not modify those workspaces.

**First workflow success target:** one real ticket on one host, with a scoped plan, working change, validation evidence, independent review, and a handoff in its vault that a fresh application session can resume correctly with Obsidian closed. Mission Control links the task, workspace, agent, and observed evidence. The daily note links the work and evidence. That foundation supports LFG, schedules, delivery/cleanup decisions, and the remaining hosts.
