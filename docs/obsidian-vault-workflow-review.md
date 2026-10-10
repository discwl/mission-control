# Obsidian vaults in Development Flow

Reviewed 19 September 2026. Research and proposed integration; nothing has been installed on your hosts. Hermes remains on hold.

**Recommendation: give each host an Obsidian vault, register it as a Paseo project, and make the shared development skills explicitly read and write that vault.** It becomes the host's durable project context, work history, and continuation record. Start with one host and one application.

The vault should answer two different questions: “What is the current spec and next action?” and “What happened on this date?” Keep persistent project/task records alongside dated summaries. Link them instead of copying the latest plan into every daily note.

## What I researched

I searched GitHub and inspected the named repositories, related tools, official Obsidian documentation, and selected skill/hook implementations. This is a source review, not a runtime test of the combined Paseo/Windows setup. Repository snapshots can contain changes newer than published releases.

| Repository or tool | Useful part | Recommendation |
|---|---|---|
| [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) | Skills for Obsidian Markdown, Bases, Canvas, CLI, web extraction, and template rendering | Use the relevant skills as the formatting/tool foundation |
| [breferrari/obsidian-mind](https://github.com/breferrari/obsidian-mind) | Session context, standups, wrap-ups, linked work/knowledge notes, and vault maintenance | Closest workflow reference; adapt its lifecycle to our development records |
| [mattpocock/skills](https://github.com/mattpocock/skills) | Composable planning, implementation, review, debugging, and handoff instructions | Select individual practices and adapt their paths, tracker behavior, and delivery actions |
| [bitbonsai/mcpvault](https://github.com/bitbonsai/mcpvault) | Local MCP access directly to vault files; Obsidian can be closed | First MCP candidate if ordinary agent file access is insufficient |
| [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) | Current source includes REST and built-in MCP, plus access to live app commands/metadata | Optional when interaction with the running Obsidian app is useful |
| [eugeniughelbur/obsidian-second-brain](https://github.com/eugeniughelbur/obsidian-second-brain) | Daily logging, knowledge maintenance, and a documented freshness policy | Borrow freshness rules; evaluate as an alternative lifecycle system |
| [Ar9av/obsidian-wiki](https://github.com/Ar9av/obsidian-wiki) | Ingest sources into linked knowledge, distinguish evidence from inference, flag contradictions | Later candidate for maintaining company/project reference knowledge |
| [basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory) | Markdown knowledge through MCP, with a local SQLite index and search | Later alternative if cross-session retrieval outgrows simple file search |
| [Obsidian Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin) | Editable drawings stored in the vault, embedded in and linked to notes | Selected addition for visual design and clarification |
| [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) | Agent drawing tools, visual inspection, and native Obsidian-format import/export | Preferred MCP candidate for the visual-design pilot; verify the installed release |

Choose one owner for session startup, daily maintenance, and handoff writing. Obsidian Mind, Second Brain, Wiki, and Basic Memory overlap; stacking their complete workflows would introduce competing conventions and duplicate maintenance.

## Kepano's skills: what to use

The repository follows the Agent Skills format. These are agent instructions, distinct from an Obsidian community plugin or a Paseo plugin. Confirm discovery in a fresh session through the provider actually launched by Paseo. [Repository documentation](https://github.com/kepano/obsidian-skills/blob/3ccff5338ea700537839b21900aa5358a0402c98/README.md)

| Skill | Our use | Timing |
|---|---|---|
| [obsidian-markdown](https://github.com/kepano/obsidian-skills/blob/3ccff5338ea700537839b21900aa5358a0402c98/skills/obsidian-markdown/SKILL.md) | Consistent properties, wikilinks, notes, and handoffs | First pilot |
| [obsidian-bases](https://github.com/kepano/obsidian-skills/blob/3ccff5338ea700537839b21900aa5358a0402c98/skills/obsidian-bases/SKILL.md) | Views of active tasks, blocked runs, and recent handoffs | First useful dashboard |
| [knap](https://github.com/kepano/obsidian-skills/blob/3ccff5338ea700537839b21900aa5358a0402c98/skills/knap/SKILL.md) | Render agreed Markdown templates from structured run data | When automating records |
| [defuddle](https://github.com/kepano/obsidian-skills/blob/3ccff5338ea700537839b21900aa5358a0402c98/skills/defuddle/SKILL.md) | Import readable web references with their URL and retrieval date | When collecting references |
| [json-canvas](https://github.com/kepano/obsidian-skills/blob/3ccff5338ea700537839b21900aa5358a0402c98/skills/json-canvas/SKILL.md) | Optional visual maps of projects or epic dependencies | When a map adds value |
| [obsidian-cli](https://github.com/kepano/obsidian-skills/blob/3ccff5338ea700537839b21900aa5358a0402c98/skills/obsidian-cli/SKILL.md) | App queries, navigation, and later plugin debugging | Optional app integration |

Knap generates files; it does not manage task ownership, approvals, or concurrent edits. Keep those responsibilities in our small workflow helpers.

Obsidian's official CLI requires the app to run and may launch it on the first command. Its documentation currently specifies installer 1.12.7+ and CLI registration in Settings. Always target the configured vault explicitly. The scheduled workflow should use ordinary files when a desktop app is unavailable. [Official CLI documentation](https://help.obsidian.md/cli)

## Obsidian Mind: the closest match

The project you remembered is **breferrari/obsidian-mind**. It provides a structured vault with work, organizational context, reference material, durable knowledge, and session lifecycle hooks. Its recommended installer also sets up its own conventions and optional search infrastructure; a clean trial vault is the appropriate place to evaluate the complete distribution. [Mind overview](https://github.com/breferrari/obsidian-mind/blob/af615d100a1d04561409ab9a1e71e615efa1d87b/README.md)

Three pieces fit especially well:

- **Session startup:** load a bounded orientation and pointers to relevant notes. The implementation budgets injected context and uses a smaller form for resumed sessions. Borrow that approach for company → project → task context. [Context-loading implementation](https://github.com/breferrari/obsidian-mind/blob/af615d100a1d04561409ab9a1e71e615efa1d87b/.claude/scripts/lib/session-start.ts)
- **Morning standup:** yesterday's work, current tasks, open follow-ups, and suggested focus. Its command assumes startup context already exists and uses Obsidian CLI queries. Our adapter must supply the same information through files for unattended runs. [Standup command](https://github.com/breferrari/obsidian-mind/blob/af615d100a1d04561409ab9a1e71e615efa1d87b/.claude/commands/om-standup.md)
- **Wrap-up:** verify changed notes, metadata, links, indexes, and useful lessons. Extend this with Git state, actual validation, review findings, approvals, blockers, and a precise next action. [Wrap-up command](https://github.com/breferrari/obsidian-mind/blob/af615d100a1d04561409ab9a1e71e615efa1d87b/.claude/commands/om-wrap-up.md)

There is an integration detail to handle: the inspected startup script selects a provider project directory or current working directory as its root. An agent in an application repository therefore needs an explicit mapping to the separate host vault. Installing a vault project alone does not establish this mapping. Provider hooks also need verification through Paseo's actual launch path. [Startup root selection](https://github.com/breferrari/obsidian-mind/blob/af615d100a1d04561409ab9a1e71e615efa1d87b/.claude/scripts/session-start.ts)

My choice is to adapt these lifecycle pieces into Development Flow first. Evaluate the complete Mind distribution separately if its additional personal-work conventions are also desirable. It should not become a prerequisite for the first application ticket.

## Matt Pocock's skills: the selected pieces

These are the names and behavior in the reviewed repository snapshot. Each row links to the actual skill, rather than assuming older skill names still describe the current project.

| Skill | Where it helps | Adaptation for us |
|---|---|---|
| [grill-with-docs](https://github.com/mattpocock/skills/blob/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/engineering/grill-with-docs/SKILL.md) | Clarify an uncertain feature while developing its domain documentation | Use for unresolved design questions before planning |
| [domain-modeling](https://github.com/mattpocock/skills/blob/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/engineering/domain-modeling/SKILL.md) | Define company/project terms and record consequential decisions | Map its glossary and ADR paths to the project's canonical documentation |
| [to-spec](https://github.com/mattpocock/skills/blob/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/engineering/to-spec/SKILL.md) | Turn settled discussion into a feature spec | Save the proposed spec in the vault; publish to a tracker through the configured authorized adapter |
| [to-tickets](https://github.com/mattpocock/skills/blob/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/engineering/to-tickets/SKILL.md) | Split an epic into independently verifiable slices with dependencies | Keep stable ticket IDs and tracker links; use our vault paths for local records |
| [diagnosing-bugs](https://github.com/mattpocock/skills/blob/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/engineering/diagnosing-bugs/SKILL.md) | Establish a reproducible failure, investigate, fix, and verify | Save the meaningful reproduction and regression evidence with the run |
| [tdd](https://github.com/mattpocock/skills/blob/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/engineering/tdd/SKILL.md) | Tests of observable behavior through appropriate interfaces | Agree validation within the plan; apply where meaningful for the change |
| [code-review](https://github.com/mattpocock/skills/blob/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/engineering/code-review/SKILL.md) | Distinguish standards findings from specification findings | Add the two dimensions to the existing fresh OCR/Gortex review path |
| [handoff](https://github.com/mattpocock/skills/blob/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/productivity/handoff/SKILL.md) | Concise continuation notes that reference existing artifacts | Save durably under the run; its original OS temporary-directory destination is unsuitable here |
| [writing-for-agents](https://github.com/mattpocock/skills/blob/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/productivity/writing-for-agents/SKILL.md) | Clear completion conditions, small entry documents, and targeted context pointers | Use as a design reference for our shared instructions and vault index |

Four details prevent a direct installation from being the finished integration:

1. The setup skill explicitly scaffolds GitHub, GitLab, or local Markdown, with other trackers recorded as custom workflow prose. Our Jira/ADO access still needs its configured adapter and real host access. [Setup skill](https://github.com/mattpocock/skills/blob/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/engineering/setup-matt-pocock-skills/SKILL.md)
2. The `implement` skill ends by committing. Our wrapper must preserve the task's delivery permissions. [Implementation skill](https://github.com/mattpocock/skills/blob/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/engineering/implement/SKILL.md)
3. The review skill's default comparison ends at `HEAD`. Our review must include the full candidate, including relevant uncommitted edits. Keep independent review and revision-specific evidence already defined in our roadmap. [Review implementation](https://github.com/mattpocock/skills/blob/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/engineering/code-review/SKILL.md)
4. Several workflows are marked for user invocation. Build our LFG composition deliberately; availability of their files does not prove automatic invocation will work through every provider. [Repository conventions](https://github.com/mattpocock/skills/blob/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/README.md)

Matt's instructions complement our existing references. Compound Engineering still informs planning/build/review/learning, Superpowers informs execution and verification, and GSD Core informs durable continuation. OpenSpec remains a reference for business specifications. Integrate these practices into one set of steps.

## Where the projects and files live

The following Windows paths are examples, not discovered paths on your PC.

| Project | Example location | Responsibility |
|---|---|---|
| Development Flow | `C:\dev\development-flow` | Shared skills, templates, schemas, adapters, and future plugin code |
| Host Brain | `C:\vaults\host-main-brain` | This host's private company/project context, tasks, daily notes, and run records; open as both an Obsidian vault and Paseo project |
| Application | Its existing repository/worktree | Product implementation, tests, Git history, and existing team documentation |

Each application profile needs `hostId`, `companyId`, `projectId`, `workspaceRoot`, `vaultRoot`, allowed context/write locations, and the host's chosen timezone. It also retains the tracker, validation commands, review configuration, and allowed actions already in our roadmap. Resolve paths for the actual runtime—Windows and WSL paths are not interchangeable.

At session start, the agent loads the selected project index, task/spec, relevant rules, and latest handoff. It reads deeper references only as needed. On stage completion, it saves a run event and updates the continuation record. This explicit bridge is what makes a separate vault useful to an agent working in another project.

For the vault, use this initial layout and create folders as they become useful:

| Location inside the vault | Contents |
|---|---|
| `Home.md`, `Host.md` | Navigation, host identity, configured project links, observed host status |
| `Companies/<company>/` | Company context, terminology, business rules, and source links |
| `Projects/<project>/Overview.md` | Project entry point, architecture references, active work, and relevant workflows |
| `Projects/<project>/Epics/` | Durable epic goals and linked feature/task dependencies |
| `Projects/<project>/Features/<feature>/` | Spec, plan, and consequential decisions across multiple days |
| `Projects/<project>/Features/<feature>/Diagrams/` | Editable `.excalidraw.md` drawings and derived SVG/PNG previews; shared project diagrams can live under the project's own `Diagrams/` |
| `Projects/<project>/Tasks/` | Stable task IDs, acceptance criteria, tracker pointers, and latest run links |
| `Runs/<run-id>/` | `Run.md`, `Handoff.md`, review/validation artifacts, and separate event notes |
| `Meetings/Talat/YYYY/MM/<exported filename>.md` | Talat's native Markdown export; preserve the source meeting content and any optional audio alongside it |
| `Meetings/Processed/<meeting-key>.md` once implemented | Separate context note with source, company/project and daily-note links; agents preserve Talat exports and human edits |
| `Daily/YYYY/MM/YYYY-MM-DD.md` | Morning focus, chronological activity links, nightly checkpoint, and carry-forward items |
| `Knowledge/` | Verified reusable lessons and patterns with supporting evidence |
| `Workflows/` | Host/company operating procedures and pointers to the shared skill version |
| `Inbox/`, `Templates/`, `Views/` | Quick capture, installed template copies, and `.base` views |

The daily note organizes the day. The feature/spec and task records carry across days. A long-running feature should not acquire a competing new spec every morning.

Existing team-controlled specifications or ADRs can remain canonical in their repository or tracker. The vault stores links and dated context around them. Where the vault owns a private specification, identify it explicitly as canonical and link from the application profile. Avoid two independently editable copies of the same requirement.

## How the daily flow works

| Moment | Read | Write |
|---|---|---|
| Morning | Last handoff, active tasks, current Git/tracker/agent state, relevant project context | Today's proposed focus, reconciled blockers, and links to resumable runs |
| Intake and planning | Ticket, company rules, glossary, existing code, related specs | Canonical task/spec/plan and any unresolved decision |
| Build and validation | Approved scope and current workspace | Actual change/check events, results, and candidate revision or dirty-state evidence |
| Fresh review | Full candidate, acceptance criteria, standards, validation | Findings and coverage tied to the reviewed candidate |
| After a meeting | Completed source transcript, host scope, known project context | Titled meeting record, grounded decisions/proposed actions, and a link submitted to the daily-rollup owner |
| Handoff/nightly | Run evidence plus a safe current checkpoint | Exact next action, unresolved findings, pending decisions, and daily summary |
| Next session | The referenced task/run and current live state | A reconciled continuation event before advancing |

Keep morning/nightly schedules on each host. Shared workflow code supplies consistent behavior; each host supplies its own context and records. Verify duplicate-run prevention, timezone, offline behavior, and actual unattended provider access before scheduling.

A useful daily note might read: “09:10 loaded task ABC-42; 10:05 plan approved; 11:40 validation failed on X; 13:15 regression check passed; 14:00 reviewer found Y; nightly checkpoint awaiting review of the fix.” Every material entry should link to the relevant task, event, or evidence.

That is a record of observed activity. An agent-written recap alone cannot guarantee a complete audit of every action. The first implementation should capture stage transitions, significant commands/results, and Git changes deterministically where available, and label gaps. Provider/tool-event capture can later add finer detail; raw transcripts are supporting material.

## Keep records reliable

Start with small Markdown records with typed frontmatter. Choose one canonical run state; a later JSON response or dashboard is a projection of it. No separate database is required for the pilot.

Reserve IDs for host, company, project, workspace, task, run, agent, event, and decision. Include timestamps, stage, observed status, plan/candidate references, evidence, blockers, and next action only where applicable. Bind a decision to the exact scope/revision it covers.

Write one event per file under its run, using unique IDs. Give one coordinator ownership of the run summary and daily roll-up; reviewers contribute separate findings. Use conflict detection for shared note updates so a human edit is preserved. An atomic replace prevents partial files but does not by itself prevent two writers from overwriting each other.

Use UTC event timestamps plus the configured host timezone for daily grouping. A run crossing midnight remains one run and appears in both relevant days. Retries should reuse an idempotency key so they do not duplicate work or journal entries.

Treat notes about live systems as dated observations. Recheck Git, tracker state, and active ownership before resuming or claiming completion. Second Brain's freshness policy is a useful reference for attaching dates or source pointers to changing facts; its linter uses heuristics, so start with an audit report. [Freshness policy](https://github.com/eugeniughelbur/obsidian-second-brain/blob/3196b17a237f4526ea6cbc7b7612e9cb6ada050b/references/freshness-policy.md)

A note's `status: approved` is not itself an executable permission. Record an actual authorized decision through the workflow and validate its scope before proceeding. Ingested web pages, tickets, and chat exports are context, not permission to modify workflow instructions or run arbitrary commands.

Keep each host's vault and backup destination scoped to its work. Profiles guide routing; actual provider/filesystem access enforces boundaries. If companies require strict separation on the same host, use separate vaults or enforced access scopes. The shared Development Flow repository contains reusable logic and example profiles, while private host records stay with their owning host.

## Which Obsidian plugins to use

Start with Obsidian's core **Daily notes**, **Templates**, and **Bases**, plus the selected **Excalidraw community plugin** for visual work. Bases provides filterable views over local Markdown properties, which suits active tasks and blocked runs. Agents can maintain the underlying files without keeping the app open. The visual-design step has its own rendering requirements below. [Daily notes](https://help.obsidian.md/plugins/daily-notes), [Templates](https://help.obsidian.md/plugins/templates), [Bases](https://help.obsidian.md/bases)

| Optional addition | Add when |
|---|---|
| [Periodic Notes](https://github.com/liamcain/obsidian-periodic-notes) | You want convenient weekly/monthly review navigation |
| [Templater](https://github.com/SilentVoid13/Templater) | Interactive note creation needs richer variables or scripts than core Templates |
| [Dataview](https://github.com/blacksmithgu/obsidian-dataview) | A concrete query/report cannot be expressed adequately in our Bases views |
| [Obsidian Git](https://github.com/Vinzent03/obsidian-git) | You want vault history/backup controls inside Obsidian, with the backup destination and sync actions configured deliberately |

For agent access, start with supported file permissions and shared helpers. If an MCP interface is needed, **MCPVault** directly serves a configured local vault over stdio and works with Obsidian closed. Its documented vault-root restrictions do not provide separate per-project permissions within that vault. [MCPVault documentation](https://github.com/bitbonsai/mcpvault/blob/c5abeda9bed11864079f70ae7f33d134e294aad2/README.md)

Use **Local REST API's built-in MCP** when you need the running app's commands, active note, or live metadata. This server lives inside Obsidian. Its local bearer key authenticates access to the vault; it is unrelated to paid LLM API keys. Check the installed release and client compatibility rather than assuming current source features are already installed. [REST/MCP documentation](https://github.com/coddingtonbear/obsidian-local-rest-api/blob/209eff08154374bbec02142ab8e763e68fb0d13b/README.md)

Basic Memory is a later retrieval alternative: local Markdown plus an index, with optional cloud features. Obsidian Wiki is a later knowledge-maintenance alternative: source ingestion, linking, and contradiction/provenance conventions. Neither is required to save reliable daily handoffs. [Basic Memory architecture](https://github.com/basicmachines-co/basic-memory/blob/3bf2d523c0a941f71cb144a5502e7557dd025d69/README.md), [Wiki architecture](https://github.com/Ar9av/obsidian-wiki/blob/98ff6b1acb3f31a7ccc5c808f8c127858b860b21/docs/architecture.md)

## Excalidraw for design and clarification

**Selected addition:** use Excalidraw to move from conversation to an editable visual, discuss it, and capture the resulting decisions in the linked spec. Appropriate uses include feature journeys, service/data relationships, epic dependencies, and rough interface sketches. Add a drawing when it helps settle a question; a small change can proceed directly through the existing flow.

The selected [Obsidian Excalidraw plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/98d0fb193c47fb15e6505c275f5105bbc09933cb/README.md) provides the place to open, edit, embed, and link these drawings inside the host vault. It also supports automatically exporting SVG/PNG when a drawing is saved. These previews are derived artifacts; retain the editable drawing as the source.

For the agent side, pilot **yctimlin/mcp_excalidraw**. It provides a local browser canvas, MCP tools, and a CLI/skill interface for creating, inspecting, and refining drawings. The canvas is held in memory, so every useful result must be exported to the vault before the session ends. Image export, screenshots, and Mermaid conversion require the browser canvas to be open; element operations and scene-file export can run without it. Obsidian itself need not be open for file export. [Toolkit behavior](https://github.com/yctimlin/mcp_excalidraw/blob/713706e967ed21db1d9264748fa01c6af961c792/README.md)

The inspected MCP tool definitions explicitly support `export_scene` to `.excalidraw.md` and `import_scene` from that format. The parser handles both plain and compressed drawing JSON. This gives us a file-based exchange with the Obsidian plugin; it is not an automatic live connection to its open board. [MCP tool definitions](https://github.com/yctimlin/mcp_excalidraw/blob/713706e967ed21db1d9264748fa01c6af961c792/src/core/mcp-tools.ts), [Obsidian format adapter](https://github.com/yctimlin/mcp_excalidraw/blob/713706e967ed21db1d9264748fa01c6af961c792/src/core/obsidian-md.ts)

Use the shared `clarify-with-diagram` step during feature discovery or `plan-task`, alongside Matt Pocock's clarification/spec practices and the Compound Engineering/Superpowers workflow:

1. Load the project context and identify the specific question the drawing should clarify.
2. Create or import a scoped drawing. Use separate canvases or serialized ownership for different projects/runs; agents must not clear or modify each other's canvas.
3. Inspect a rendered preview, correct labels/arrows/layout, and distinguish proposed behavior from established facts. If rendering is unavailable, record that visual verification remains pending.
4. Discuss or edit the drawing with the user. Record resolved decisions and open questions in the feature's spec/design note. Apply the existing plan decision to its defined scope.
5. Save the editable drawing under `Projects/<project>/Features/<feature>/Diagrams/flow.excalidraw.md`. Link it from the spec, plan, run, and relevant daily note; generate a preview where useful for Paseo.
6. Before the agent changes it again, import the latest saved version, check for newer human edits, and preserve the agreed content. Record the updated artifact revision in the run.

**Preservation detail found in source:** the toolkit's Markdown exporter generates a fresh wrapper/frontmatter, while import extracts the drawing scene. An export over an existing note can therefore remove extra Markdown prose or custom properties outside the scene. Initially keep workflow metadata and decisions in an adjacent design/spec note and export revisions to a candidate file. Before automatic replacement, our save helper must preserve existing note metadata/prose, detect concurrent edits, and verify drawing links and attachments. [Export implementation](https://github.com/yctimlin/mcp_excalidraw/blob/713706e967ed21db1d9264748fa01c6af961c792/src/core/mcp-dispatch.ts), [Wrapper implementation](https://github.com/yctimlin/mcp_excalidraw/blob/713706e967ed21db1d9264748fa01c6af961c792/src/core/obsidian-md.ts)

Alternatives reviewed:

- The [official Excalidraw MCP](https://github.com/excalidraw/excalidraw-mcp/blob/157aa23ceb1976008aadc89eb05e3444060f09d6/README.md) is useful for interactive diagrams inside clients supporting MCP Apps. Verify that rendering capability separately from ordinary MCP tool support in Paseo. Our preference for the toolkit here comes from its explicit vault-file exchange.
- [MultiUpGame/mcp-obsidian-excalidraw](https://github.com/MultiUpGame/mcp-obsidian-excalidraw/blob/2c26f3537da0083e0c878a9f0f91bab07870931b/README.md) offers direct live drawing in Obsidian through an additional bridge plugin. It requires an open board and documents an unauthenticated command endpoint with script execution. Retain it as a reference for future in-app interaction; it is outside the initial installation set.

Keep the local drawing service scoped to its host. The main PC's paired-host view can show saved previews through the planned host adapter; pairing does not itself expose another host's local browser canvas. The morning/nightly handoff routines continue to work without invoking diagram rendering.

Add one visual round-trip to the pilot: generate a small feature flow, save it, open and edit it in Obsidian, import the edited version, revise it with the agent, and reopen the result. Check labels, arrow bindings, links, attachments if used, and retention of human edits. This is proposed validation; no toolkit or plugin has been installed or tested on the user's host during this research.

## Meeting capture into the vault

Updated 2 October 2026: **Talat is the chosen meeting app and the user reports it is working well.** Use its [native Obsidian integration](https://talat.app/docs/integrations/obsidian) to export Markdown into the meeting host's vault. The [meeting workflow](meeting-capture-vault-workflow.md) describes the setup, file ownership and verification steps. Talat replaces the earlier recorder selection; a custom vault writer is unnecessary for this path.

Keep exported source notes in `Meetings/Talat/` and reserve `Meetings/Processed/` for later agent-written context. The proposed `ingest-meeting` step is not installed or implemented. It should link meetings to the correct project and daily note, record supported decisions and proposed actions, prevent duplicate ingestion, and preserve source files and human edits. Uncertain project or host routing needs clarification.

Meeting-aware morning/nightly reconciliation and automatic task intake remain planned. Approved work should use the owning host's Jira or Azure DevOps configuration and normal development flow. A transcript or generated action point does not establish execution or delivery approval. Verify the native export on the recording host before adding processing or expanding to other meeting hosts.

## Where our own plugins fit

The future **Paseo Development Flow Control Center** should expose agents, decisions, runs, and daily summaries from these records. Preserve the existing Agent Monitor, Agent Crew, Review Deck, GSD Observer, and schedule-runs references in [the Paseo review](paseo-plugin-reference-review.md).

Paseo's documented cross-host client API supports native operations on paired hosts. It does not automatically expose their vault files. A scoped host-side adapter must supply the richer summaries/evidence, including host identity and freshness. That lets the main PC ask for host updates without requiring all private vault contents to be synchronized into one folder. [Paseo cross-host API](https://paseo.sh/docs/plugins/reference#discover-hosts-and-target-another-host)

A later **Obsidian companion plugin** could offer Today's Work, project/task navigation, note creation, stale-handoff indicators, and a command to open the corresponding Paseo workspace. Both interfaces should use the same record contract. Keep execution and approvals in one workflow so the two interfaces cannot disagree about whether a run may continue.

The existing Excalidraw plugin supplies drawing/editing. Our future Paseo UI can show a saved preview beside the related plan or question, with navigation to the owning host's editable artifact. Validate the actual preview/open behavior on the target host; this is an addition to our proposed UI, not an existing integration claim.

If those interactions justify a custom plugin, start with the official TypeScript sample and Kepano's CLI development helpers. A core Bases dashboard is enough to learn what the first custom screen needs. [Official Obsidian plugin template](https://github.com/obsidianmd/obsidian-sample-plugin)

## First implementation milestone

1. Create the shared Development Flow project and one Host Brain vault on the main PC; register both as separate Paseo projects.
2. Connect one existing application through an explicit profile and verify the selected provider can read/write only the intended locations.
3. Add the relevant Kepano skills and the selected Obsidian Excalidraw plugin. Draft project, task, run, handoff, and daily templates using the agreed fields. Pilot the Excalidraw MCP toolkit on one feature diagram and verify the file round-trip described above.
4. Build `load-context` and `record-progress` as small shared helpers used by `check-environment` and `write-handoff`. Keep individual development stages callable.
5. Run one modest ticket manually through planning, implementation, validation, fresh review, and a saved handoff.
6. Close the session and Obsidian. Launch a fresh application agent and prove it finds the correct vault context, reconciles the actual workspace, and resumes without losing or duplicating work.
7. Try morning/nightly routines manually. Then schedule the pilot host, add a second host, and build the first control-center view from real records.

**Success means you can open a day's note, follow the evidence for its work, and have a fresh agent continue the right task from the right checkpoint.** That gives the fleet a useful memory foundation while preserving the development flow already chosen.

### Research snapshots

For reproducibility, the main reviewed revisions were Kepano `3ccff5338ea7`, Matt Pocock `c55ee46073ed`, Obsidian Mind `af615d100a1d`, Second Brain `3196b17a237f`, Wiki `98ff6b1acb3f`, MCPVault `c5abeda9bed1`, Local REST API `209eff081543`, and Basic Memory `3bf2d523c0a9`. Links above pin the implementation details that affect our design. Recheck supported releases and host compatibility during installation.

The Excalidraw addition reviewed Obsidian Excalidraw `98d0fb193c47`, yctimlin's toolkit `713706e967ed`, the official MCP `157aa23ceb19`, and the direct Obsidian bridge `2c26f3537da00`. The native Markdown format and export-preservation findings were checked in source, not inferred solely from project descriptions.

This document adds the vault design to the existing skills-first roadmap. The planning bundle retains the original source notes and review kit; it does not contain installed skills, a configured host vault, or an activated schedule.
