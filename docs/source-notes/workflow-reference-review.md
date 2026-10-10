# Open-source references for the daily development and LFG workflow

Reviewed 17 September 2026. This is a design review of public source and documentation, not an installation or an end-to-end compatibility test.

**Recommendation:** use Compound Engineering as the main reference for composable skills and learning; Superpowers for implementation and review discipline; Addy Osmani’s Factory for scheduled work and explicit operating limits; GSD Core for pause/resume; and OpenSpec for business requirements. Keep Finn-loop as a small, particularly useful reference for ticket contracts and review evidence. Use these patterns within the existing Paseo + OCR delegation + Gortex arrangement.

The ranking reflects fit with your notes, not a benchmark of coding quality. Source inspection establishes what the instructions and helpers do; it does not establish that one framework finds more defects than another.

## 1. Primary references

| Priority | Repository | What to borrow | Application to your flow |
|---|---|---|---|
| 1 | [Compound Engineering](https://github.com/EveryInc/compound-engineering-plugin) | Individual workflow skills, LFG composition, selective durable learning, repository defaults with local overrides | Main reference for how your skills fit together |
| 2 | [Superpowers](https://github.com/obra/superpowers) | Explicit plans, spec compliance and code quality verdicts, systematic debugging, verified completion, critical handling of review feedback | Build, validate, review and fix |
| 3 | [Addy Osmani’s Factory](https://github.com/addyosmani/factory) | Human-owned charter, bounded runs, one claimed task, independent verification, review queue limits | Morning launch, scheduled execution and human gates |
| 4 | [GSD Core](https://github.com/open-gsd/gsd-core) | Structured pause/resume state, measured uncommitted changes, exact next action, reconciliation of interrupted work | Nightly handoff and morning recovery |
| 5 | [OpenSpec](https://github.com/Fission-AI/OpenSpec) | Existing system requirements separated from proposed changes; project context and artifact-specific rules | Business context and ticket acceptance criteria |
| Supporting | [Finn-loop](https://github.com/finna/Finn-loop) | Small ticket contract, explicit non-goals, review against the current PR revision | Intake and final review evidence |

### Compound Engineering: closest match to the intended structure

Its actual workflow includes planning, implementation, simplification, review and learning skills, plus an LFG coordinator. That is very close to the individual-skills-first approach in your notes. The best idea is that the coordinator invokes the same underlying skills you can invoke manually. It should not maintain a second implementation of planning or review. [LFG source](https://github.com/EveryInc/compound-engineering-plugin/blob/082c83e0537c803ac1d927daafc2e6eb6962dedf/skills/lfg/SKILL.md)

The most valuable addition to our proposed flow is **capture a useful lesson after verified work**. Its compound skill only documents reasoning that is not already adequately explained by the final code, tests or existing documents. That avoids producing a retrospective for every trivial edit. For example, record a surprising EF Core behavior, the relevant conditions, the verified solution and how a later agent can find it. [Learning skill](https://github.com/EveryInc/compound-engineering-plugin/blob/082c83e0537c803ac1d927daafc2e6eb6962dedf/skills/ce-compound/SKILL.md)

Its configuration distinguishes committed project defaults from checkout-local overrides. That is a useful model for your different machines. Its experimental Compound Packs also offer a reference for distributing shared rules, but their format is explicitly subject to change. Do not make an experimental pack mechanism a prerequisite for the first version. [Configuration source](https://github.com/EveryInc/compound-engineering-plugin/blob/082c83e0537c803ac1d927daafc2e6eb6962dedf/docs/guides/configuration.md)

Adaptations needed:

- Upstream LFG explicitly proceeds through commits, pushes and PR creation. Your version must retain the permissions you selected for each action.
- Its default handoff destination can be temporary storage. Your nightly handoff needs an explicitly durable destination that survives the workspace lifecycle.
- Its handoff resume behavior orients the user and waits for confirmation. An approved scheduled morning routine needs its own clear continuation policy and a specific handoff pointer.
- Preserve OCR delegation as our review scope/rules component and Gortex as context access. Do not accidentally run a second complete review framework because LFG defaults to CE’s review skill.

The latter two points are integration recommendations, not claims of a native OCR/Paseo adapter. [Handoff source](https://github.com/EveryInc/compound-engineering-plugin/blob/082c83e0537c803ac1d927daafc2e6eb6962dedf/skills/ce-handoff/SKILL.md), [resume source](https://github.com/EveryInc/compound-engineering-plugin/blob/082c83e0537c803ac1d927daafc2e6eb6962dedf/skills/ce-handoff/references/resume.md)

### Superpowers: strongest reference for the quality steps

Read its implementation workflow and reviewer prompt together. The inspected version uses fresh implementer contexts, a task review that produces separate spec-compliance and code-quality verdicts, and a broader final branch review. This distinction is useful: code can be technically sound while implementing the wrong requirement. It does not require us to create two reviewer agents for every small task. [Implementation workflow](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/subagent-driven-development/SKILL.md), [task reviewer](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/subagent-driven-development/task-reviewer-prompt.md)

Two especially useful skills are verification-before-completion and receiving-code-review. Borrow the requirements to support completion claims with actual evidence and to investigate feedback before applying it. OCR findings should be hypotheses to validate against code, tests and Gortex context. [Verification source](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/verification-before-completion/SKILL.md), [feedback source](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/receiving-code-review/SKILL.md)

Its policies are opinionated. The implementation workflow can resolve ambiguities autonomously and has its own repair-loop and workspace conventions. Preserve your human decision points, use the existing Paseo worktree, and keep our initial repair limit at two rounds. Use meaningful tests for the change; do not mechanically import every blanket instruction. The source’s task reviewer also permits reuse of visible evidence for exactly the reviewed code, which supports avoiding needless repeated test runs.

### Addy Osmani’s Factory: best reference for scheduled runs

The useful structure is a human-owned charter defining allowable work, sensitive areas, required checks and stop conditions. Its contract takes one queue item per run and uses an independent verifier. It also stops production when the human review queue reaches its limit. For your morning schedule, that is more useful than an unlimited loop that keeps generating work. [Charter](https://github.com/addyosmani/factory/blob/8af116567166a0a16588b7ab1b9934ece0b775bc/template/docs/factory/CHARTER.md), [contract](https://github.com/addyosmani/factory/blob/8af116567166a0a16588b7ab1b9934ece0b775bc/template/docs/factory/CONTRACT.md)

Its verifier reads the change independently, checks required gates and asks whether the regression test actually detects the original defect. Borrow that last check for meaningful bug fixes, performed in an isolated validation checkout where reverting a fix is necessary. [Verifier source](https://github.com/addyosmani/factory/blob/8af116567166a0a16588b7ab1b9934ece0b775bc/template/.claude/agents/factory-verifier.md)

This repository is a procedural template, with documented scheduling and execution supplied by external host capabilities. Its GitHub issue labels, handoff comments and remote-branch claim mechanism are implementation choices. We should adapt the ownership principle to the selected tracker and Paseo workspace instead of copying GitHub writes into a Jira/ADO setup. It does not itself prove that your local machine can run scheduled Paseo sessions unattended. [Architecture](https://github.com/addyosmani/factory/blob/8af116567166a0a16588b7ab1b9934ece0b775bc/ARCHITECTURE.md), [limits](https://github.com/addyosmani/factory/blob/8af116567166a0a16588b7ab1b9934ece0b775bc/LIMITS.md)

### GSD Core: best reference for the nightly/morning boundary

The current pause workflow writes both a structured handoff and a human-readable continuation note. Its state includes completed work, remaining tasks, decisions, blockers, pending human actions, modified files and a specific next action. Particularly useful: uncommitted files must come from an actual Git status check. Resume compares that saved state against the current checkout and accounts for outstanding external jobs before restarting work. [Pause source](https://github.com/open-gsd/gsd-core/blob/651511d1e322759a11ddcb37f3456ec9ba4b2aa5/gsd-core/workflows/pause-work.md), [resume source](https://github.com/open-gsd/gsd-core/blob/651511d1e322759a11ddcb37f3456ec9ba4b2aa5/gsd-core/workflows/resume-project.md)

Borrow these state fields, but start with one canonical handoff record. Human-readable and machine-readable views should represent that same state rather than becoming independently edited accounts. Pin the task identity; the newest file by timestamp is not sufficient when multiple tickets are active.

The original `gsd-build/get-shit-done` repository is archived and directs users to GSD Core. Reference the current repository when implementing. The inspected GSD Core snapshot came from its `next` branch; source availability is not a claim that every detail is in a particular stable release. [Migration notice](https://github.com/gsd-build/get-shit-done)

### OpenSpec: best reference for business context

OpenSpec separates the system’s established specifications from proposed changes. Its requirements and scenarios are particularly relevant to business rules: describe existing behavior and explicitly describe what this ticket changes. [Concepts](https://github.com/Fission-AI/OpenSpec/blob/634c557bd0470eec37861b46172c3f503d283c1b/docs/concepts.md)

Its project configuration injects context and artifact-specific rules, with optional custom schemas. Borrow that separation between general project knowledge and the instructions relevant to a particular stage. For your first version, a compact ticket document with acceptance criteria, non-goals and links to business rules is enough; a complete new specification framework is optional. Configuration is prompt guidance, not an executable guarantee that the implementation meets the requirements. [Customization](https://github.com/Fission-AI/OpenSpec/blob/634c557bd0470eec37861b46172c3f503d283c1b/docs/customization.md)

### Finn-loop: small enough to understand and adapt

Its spec skill creates observable acceptance criteria with stable identifiers, explicit non-goals, relevant files and verification expectations. Its reviewer checks the linked ticket and the exact PR head, then verifies the head has not changed before posting the verdict. That is an excellent reference for preventing stale review approvals. [Spec skill](https://github.com/finna/Finn-loop/blob/7941b62c946154d15c11b7f24931bb8b6e155f01/skills/finn-spec/SKILL.md), [review skill](https://github.com/finna/Finn-loop/blob/7941b62c946154d15c11b7f24931bb8b6e155f01/skills/finn-review/SKILL.md)

Its starter workflow uses Linear and GitHub. Borrow the task contract and revision checks; replace the tracker-specific operations. Labels indicating automated approval are evidence for a human decision, not permission to merge.

## 2. Additional repositories worth keeping nearby

These received a narrower source/documentation review than the primary references.

| Repository | Useful idea | Recommendation |
|---|---|---|
| [Planning with Files](https://github.com/OthmanAdi/planning-with-files) | Persistent plan, findings and progress; selected task identity; one owner of shared planning files | Good lightweight alternative for state management. Use its pattern instead of maintaining a second parallel GSD-style state system. |
| [GitHub Spec Kit](https://github.com/github/spec-kit) | Project principles and requirements carried into plans and tasks; separate bug diagnosis, fix and verification entry points | Reference for larger specification work or a dedicated bug-fix skill. OpenSpec is the initial requirements reference for our design. |
| [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) | Explicit decisions and retained context; process depth adjusted to the size of the change | Useful when work grows into product briefs and architecture. Its current documentation supports small-change entry points, so it should not be dismissed as invariably heavyweight. |
| [Ralphy](https://github.com/michaelshimeles/ralphy) | Task queues, bounded/configurable execution and isolated parallel tasks | Learn execution-loop mechanics later. Its extra runner and worktree management overlap the chosen orchestration layer. |
| [Cole Medin’s AI Software Factory](https://github.com/coleam00/ai-software-factory) | Independent runtime verification and holdout scenarios | Study for high-risk changes later. The current architecture routes AI stages through Archon, which is a larger adoption than our initial workflow. |
| [Gas City](https://github.com/gastownhall/gascity) | Durable work routing, coordination and health supervision | Reference when concurrent workers and recovery become a demonstrated need. It is an orchestration SDK, so adopting it now would add another orchestration system. |

Planning with Files’ actual skill pins recovery to a selected plan and prevents workers from independently overwriting shared planning state. That ownership detail is worth borrowing even if none of its hooks are installed. [Skill source](https://github.com/OthmanAdi/planning-with-files/blob/746f57a7c51797bee512edd3e0ded277916f8cb3/skills/planning-with-files/SKILL.md)

## 3. Changes these references suggest for your design

The following is our proposed synthesis, not configuration already implemented by an upstream repository.

| Your component | Proposed behavior | Main references |
|---|---|---|
| Morning | Load the selected profile and exact handoff; verify repository, branch, tools and task status; resume approved work or prepare today’s plan | GSD Core, Addy Factory |
| Intake | Produce a tracker-independent task record with source URL, acceptance criteria, non-goals, business-rule references and unresolved questions | Finn-loop, OpenSpec |
| Plan | Reuse existing code patterns; choose small steps; include validation and obtain the configured human approval | Compound Engineering, Superpowers |
| Execute | Work within the approved scope and existing workspace; record progress and blockers | Superpowers |
| Simplify | Remove unnecessary complexity within the change; validate after code edits | Compound Engineering |
| Validate | Run configured build/test/lint checks; record the code revision, command, result and relevant evidence | Superpowers, Addy Factory |
| Review | Fresh reviewer; assess acceptance criteria separately from code defects; OCR scope/rules and Gortex investigation | Superpowers, Finn-loop, existing OCR/Gortex design |
| Fix | Investigate each finding; fix substantiated issues; rerun affected checks and obtain review of the revised code | Superpowers |
| Learn | Save a non-obvious verified lesson when it will prevent recurrence; require human acceptance before promoting it into a business rule | Compound Engineering |
| Nightly | Reach a safe checkpoint; record completed/remaining work, Git state, running jobs, approvals and the exact next action | GSD Core, Compound Engineering |
| Cleanup | Identify merged branches, obsolete workspaces and completed sessions; apply your cleanup permission policy | Existing workflow requirement |

**LFG should be a thin coordinator of those same skills.** A sensible default sequence is intake → plan → human plan decision → execute → simplify as needed → validate → fresh OCR/Gortex review → bounded fix/validate/re-review → human review decision → authorized shipping. Capture useful learning and update the handoff as the work advances. A blocked test environment or exhausted repair budget must remain visibly incomplete.

Each stage should return a small explicit result: completed, blocked, or waiting for approval; artifact pointers; the revision it examined; and the next action. This makes scheduled and manual invocations behave consistently without building a large workflow engine.

Scheduling needs two additional rules:

1. **Repeated starts must not duplicate work.** A morning invocation checks for an existing owner and active run before taking the same ticket. Record ownership per task/workspace, adapting the Factory claim principle to the actual environment.
2. **Nightly scheduling requests a checkpoint.** It should not abruptly kill a test, switch branches under a builder or treat an ongoing background job as completed. The next morning verifies saved state before continuing.

## 4. Jira on one machine, ADO on another

Use one skill implementation with four explicit inputs:

| Input | What it contains |
|---|---|
| Project context | Repository identity, expected base branch, stack, build/test commands, business-rule documents and team conventions |
| Machine profile | Workspace path, selected tracker connection/account, available tools and services, hours/timezone |
| Task context | Jira/ADO identifier and URL, acceptance criteria, non-goals, approved plan, task-specific exceptions |
| Permission policy | Which work is approved, plan/review gates, and permissions for tracker changes, comments, commits, pushes, PRs and cleanup |

The intake skill converts a Jira issue or ADO work item into the same small task structure. The planning and review skills consume that structure, so their reasoning is not coupled to a particular tracker. Keep authentication in the connector or credential store, not in the context documents.

Print the resolved profile and important sources at the start of a run. A local profile can choose a connection and workspace path; it should not silently redefine a shared business rule. Surface conflicts for a decision, and keep approved exceptions attached to the ticket. This is inspired by CE’s local/default configuration and OpenSpec’s project context, but the combined schema is ours to implement.

For review, record both the intended base reference and the actual resolved revisions. Attach the review verdict to the candidate revision; subsequent changes require fresh evidence for the affected scope. That applies regardless of which tracker supplied the task.

## 5. Implementation scope

Start with the individual skills and one shared task/handoff format. Exercise them manually on one ticket before attaching morning and nightly scheduling. Then compose the same skills into LFG. The first integration work should resolve context, check permissions, pass artifacts between stages and stop reliably on blockers.

Avoid installing several overlapping planning, worktree and hook systems together. Keep Paseo responsible for agent/workspace lifecycle, OCR delegation responsible for review selection/rules, Gortex available for repository investigation, and the subscription-backed host agent responsible for reasoning. The reference frameworks supply specific patterns within those boundaries.

No repo in this review was validated as a complete, ready-made Windows + Paseo + OCR + Gortex + Jira/ADO integration. The primary seven source snapshots are MIT-licensed; retain applicable notices if copying their files or substantial text. Host compatibility, scheduling and connector permissions need a separate implementation smoke test.

## 6. Source snapshots

Primary repositories were inspected from Git checkouts, including the skill instructions or workflow files linked above. Addy Factory and Finn-loop checkout hashes were also compared with current remote HEAD and matched. These are source snapshots, not uniform claims about latest published package releases.

| Repository | Inspected revision | Commit date |
|---|---|---|
| Compound Engineering | `082c83e0537c803ac1d927daafc2e6eb6962dedf` | 2026-09-15 |
| Superpowers | `b36e0829c6d0140e93cfef2ca599b1b07d4a7797` | 2026-08-12 |
| GSD Core | `651511d1e322759a11ddcb37f3456ec9ba4b2aa5` | 2026-09-16 |
| OpenSpec | `634c557bd0470eec37861b46172c3f503d283c1b` | 2026-09-17 |
| Planning with Files | `746f57a7c51797bee512edd3e0ded277916f8cb3` | 2026-09-16 |
| Addy Factory | `8af116567166a0a16588b7ab1b9934ece0b775bc` | 2026-08-18 |
| Finn-loop | `7941b62c946154d15c11b7f24931bb8b6e155f01` | 2026-07-22 |
