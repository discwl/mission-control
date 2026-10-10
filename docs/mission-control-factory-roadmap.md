# Mission Control snapshot and automation roadmap

Snapshot date: 1 October 2026.

Mission Control should automatically turn ready tasks into reviewed, deliverable work, with Paseo's native schedules keeping the process moving.

The user should set priorities, answer genuine product questions and review results, without having to press Start for every task.

Each host uses either Jira or Azure DevOps tasks/work items. Planned intake must use that host's configured tracker, project and field/status mapping, keeping source links and task ownership tied to the correct host.

**Testing should begin before sprint dates and forecasting.** The existing manual workflow can be exercised now. A supervised scheduled pilot should begin once task eligibility, exclusive ownership, recovery, automatic validation and independent review work together. Unattended operation requires evidence from that pilot and its failure scenarios.

This document records the current baseline, remaining work and testing gates for the product owner and implementing agents. It is a planning snapshot, not an assertion that automation is enabled or a replacement for individual task records.

## Current position

The project has task and run records, manual launch and resume, isolated worktrees, workflow skills, review decisions and delivery actions. The main remaining capability is durable coordination across those pieces.

The connected Paseo host returned **zero saved agent profiles and zero schedules** when queried for this snapshot. These observations apply to the connected host, not every host visible in the desktop app. Native schedules and profiles are supported by Paseo; they still need to be configured and integrated into this workflow.

The checkout contains substantial uncommitted work. Its base commit is `f6219d5a6cca0c62f395836a53217687b477c5b5`, dated 29 September 2026. That commit does not identify the complete current candidate. A pilot must record the actual revision and working-tree state it exercises.

### Capability inventory

“Documented” below means described by the current operator guide or plugin README. “Reported” refers to completed work and validation reported in this conversation. Neither means a fresh end-to-end test was performed for this document.

| Area | Current evidence | Remaining work |
|---|---|---|
| Task records and context | Documented task/run identity, exact host and workspace binding, project profiles, acceptance criteria, events, handoffs, decisions and findings. | Define machine-checkable readiness and continuation rules without duplicating the records. |
| Start and resume | Documented manual Start, Resume and interrupted-launch recovery. Run and agent identities are retained; uncertain sends are not automatically repeated. | Let a scheduled coordinator invoke the same guarded path, claim a task and recover safely. |
| Work isolation | Documented task worktrees, branch configuration and task/workspace links. | Coordinate concurrent work and dependencies; prevent two writers from taking the same task. |
| Morning intake | Documented manual Morning check with a tracker-reading agent, reports and selected-item imports for Jira or Azure DevOps. Duplicate imports are compared against existing tasks. | Schedule it, select eligible imports by policy, detect changed requirements and surface unavailable tracker tools. Use each host's configured Jira or Azure DevOps tracker and project mapping. |
| Workflow skills | Installed lifecycle skills describe context checks, planning, execution, validation, review, fixes, delivery and handoff. | Make continuation, timing, escalation and coordinator ownership consistent across stages. Skills alone do not enforce automatic progression. |
| Agent profiles | Live query returned no profiles on the connected host. | Configure suitable profiles and verify that task launch materializes their provider, model, mode, thinking and supported feature settings. Automatic profile routing is not established. |
| Tests and independent review | Skills require actual validation, a fresh reviewer, OCR file/rule selection, Gortex context and revision-specific findings. | Automate the transitions, preserve coverage evidence and recheck changed candidates. A required workflow is not proof that every historical task followed it. |
| Decisions and delivery | Documented review/plan decisions, finding resolution, merge or draft-PR routes, delivery checks and results. Cleanup is explicit. | Decide and implement which delivery actions may follow acceptance automatically, including integration checks and recovery. |
| Task and document UI | Reported improvements include readable task/activity views, collapsed history, named agent actions, copy-ID controls, Markdown tables and links into Docs. | Continue native desktop/mobile testing and fix defects found in real journeys. |
| Workspace labels | Agent-managed label helper and lifecycle policy were reported implemented and live-tested. | Treat labels as a summary; they must not become the scheduler's source of task readiness or completion. |
| Continuous operation | Paseo provides native schedules; no schedules were configured on the connected host at snapshot time. | Add a durable coordinator, operating policy, health visibility and bounded recovery. |
| Timing and forecasting | Existing records contain timestamps and Git evidence. | Establish reliable task timing boundaries, waiting intervals and attempts before calculating historical estimates. Sprint/date forecasting is a later slice. |

### Known verification gaps

- The user reported Review reopening or regaining focus after switching or closing tabs. Explorer/open/discard actions were also requested. Related working-tree files exist, but this snapshot does not establish that the fixes are complete, tested or reloaded. Confirm the outcome before relying on the Review UI in the scheduled pilot.
- Native desktop/mobile visual checks remain outstanding for several reported UI changes. Passing component tests and typecheck do not establish native behavior.
- Gortex source access has been intermittent. This snapshot uses the source and documentation available through it; it is not an exhaustive code audit.
- Earlier passing test counts are historical observations, not fresh validation of today's changing checkout. No application test suite was rerun solely to write this document.

## Talat meeting input

Decision added 2 October 2026: the user has chosen **Talat** for meetings and reports it is working well. Its [native Obsidian integration](https://talat.app/docs/integrations/obsidian) is the selected source of meeting notes in the host vault. Configure the export only on hosts where meetings are attended; see the [meeting workflow](meeting-capture-vault-workflow.md).

The first checkpoint is a completed export readable in Obsidian and Mission Control Docs. Automatic meeting processing is additional work: preserve the source, deduplicate revisions/backfill, resolve the owning project and host, link daily context, and present proposed actions for normal authorization. `ingest-meeting`, meeting-aware schedule reconciliation and automatic Jira/Azure DevOps task intake are not implemented by the native export. They should use the coordinator's existing receipts and task-claim rules when built.

Talat capture and vault export can be tested now. Meeting automation, Hub adoption, sprint dates and forecasting should not delay the first ready-task-to-review pilot.

## Intended daily operation

1. A native Paseo morning schedule reads the host's configured Jira or Azure DevOps project/query, reconciles eligible items with existing tasks and produces a concise report.
2. A daytime schedule runs a fresh coordinator agent. It reads durable task/run evidence and live Paseo state, then acts only where the next step is permitted.
3. Ready work starts automatically when dependencies and capacity allow. Active agents keep working without duplicate prompts or replacement agents.
4. The workflow advances through planning, implementation, validation, independent review and bounded fixes. Standing project authorization can cover routine planning and implementation; material ambiguity produces a focused question.
5. The user receives a review package with the result, evidence, remaining risks and a recommendation.
6. Accepted work follows the project's authorized delivery route. Verified outcomes, timing and useful lessons are recorded, and the next eligible task can proceed.

A scheduled run is a wake-up, not the owner of progress. Continuity belongs in the existing task/run records and launch receipts so a new coordinator can reconcile what happened after a crash or missed response.

The initial schedule cadence should be selected for the pilot; a morning intake and a daytime check every 10–15 minutes are proposed starting points, not configured schedules. Use America/Los_Angeles unless the project specifies another timezone. Record last success, next run and missed checks, including behavior after sleep or downtime. The owning host must remain available during the operating window.

## Host coordination and the main supervisor

Recommended design added 1 October 2026: each host has a coordinator that owns its tasks and agents; the main host has a supervisor that combines progress, capacity and exceptions. This is planned functionality. The [user guide's roadmap](user-guide/mission-control-user-guide.html#roadmap-orchestration) includes the operating diagram and schedule table.

| Responsibility | Owner and boundary |
|---|---|
| Priorities, decisions and review | User; standing task/project authorization still applies. |
| Cross-host supervision | Main host: inspect freshness, missed checks, capacity and review queues. Send control requests through the owning coordinator and require acknowledgements. |
| Task coordination | Owning host: use its Jira or Azure DevOps configuration, exact workspace/repository binding and available profiles; claim tasks and advance checks, review or bounded repairs. |
| Execution and independent review | Task agents: produce revision-specific evidence and a fresh review. Agent completion alone does not establish task completion. |

Code must enforce atomic, time-bounded task claims, reject stale owners and deduplicate actions; agents provide planning and diagnostic judgment. Reconcile live workers before taking over expired claims. Preserve host, workspace, run, agent and revision in existing records and receipts. Do not create a second task database.

Start with one active implementation per pilot project. Limit new work when the review queue fills, and account for provider capacity shared across hosts. Main-host downtime must not interrupt remote work authorized by saved local policy. An unreachable remote host shows its last confirmed state, not an invented failure or replacement launch elsewhere. Cross-host task migration is outside the first pilot.

### Schedule responsibilities

Inventory existing jobs before creating or replacing any. Proposed starting cadences, within configured operating hours/timezones:

- Each host: morning Jira/Azure DevOps intake once each workday, then workflow reconciliation every 10–15 minutes.
- Main host: cross-host supervision every 15 minutes and a daily summary at the end of work.

Native [schedules](https://paseo.sh/docs/schedules.md) start fresh agents; heartbeats prompt one existing conversation. Use schedules for coordination and bounded heartbeats for individual builds/investigations. Progress lives in durable records, not the coordinator's chat. Record last success, next check and missed/failed checks. Completion events can advance work between checks once wired up.

Every entry point—schedule, intake, user action or Hub event—uses the same guarded claim/launch path. Existing build/review schedules must join this policy instead of competing for ownership. Do not repeatedly prompt working agents. Use [host-local profile notes](https://paseo.sh/docs/agent-profiles.md) and materialize the actual settings; profile names confer neither authority nor independent-review evidence.

## Paseo Hub assessment and adoption

Research checked 1 October 2026 against the [Hub docs](https://paseo.sh/docs/hub), [product page](https://paseo.sh/hub) and [public OpenAPI](https://hub.paseo.sh/api/openapi.json). Local Paseo 0.10.2 exposes Hub CLI commands but `paseo hub status --json` returned `not_connected`. Remote hosts and a live integration were not tested.

**Recommendation: evaluate Hub for shared event intake and dispatch, while Mission Control owns task policy and evidence.** The initial local scheduled pilot must work without Hub.

| Documented capability | Proposed use |
|---|---|
| Daemon identity/presence and explicit working directories | Reuse host routing while retaining the exact task binding. [Daemons](https://paseo.sh/docs/hub/daemons) |
| Provider triggers and manual API dispatch | Wake the owning coordinator. Native Jira/Azure DevOps intake is not established by the documented event catalog; retain host-local adapters. [Triggers](https://paseo.sh/docs/hub/triggers) |
| Validated, versioned dispatch configuration | Reuse target runtime checks. Current organization triggers use `.paseo/triggers/*.yml`; legacy project bundles use `hub.yml` and workflows. Verify the chosen contract instead of mixing formats. [Configuration](https://paseo.sh/docs/hub/configuration) |
| Launch recovery and execution history | Correlate Hub receipts with task/run receipts. Recovery covers Hub-dispatched agents, not every local worker. [Recovery](https://paseo.sh/docs/hub/daemons) · [Activity](https://paseo.sh/docs/hub/activity) |
| Ordered steps, conditions, structured results and runtime limits | Evaluate later check/review routes. Give each stage one dispatcher: local coordination and Hub must not both launch it. [Workflows](https://paseo.sh/docs/hub/workflows) |

Integration limits:

- Offline dispatch fails without a queued retry. Retain pending task intent and reconcile after reconnecting. [Activity](https://paseo.sh/docs/hub/activity)
- Matching triggers can both run. Conversation continuation can steer busy agents; select fresh execution for independent reviewers and coordinator wake-ups. [Triggers](https://paseo.sh/docs/hub/triggers)
- A stable manual `deliveryKey` supports deduplication but not an exactly-once guarantee. Reconcile ambiguous responses before retrying. The manual-run API is project-scoped; test compatibility with the selected trigger format. [Public API](https://paseo.sh/docs/hub/api)
- The inspected OpenAPI has no general host-health/run-history read endpoint. Start with native state plus Activity links; verify a supported read interface before embedding Hub monitoring.
- Enrollment and execution authority are separate. `hub.execute` also covers existing agents/workspaces; begin with a controlled test host. [Security](https://paseo.sh/docs/hub/security)
- Hub completion does not approve tasks or delivery. Keep validation, OCR/Gortex independent review, candidate freshness and user decisions authoritative. Do not assume Hub named agents synchronize saved native profiles or installed skills.

A self-hosted pilot on an always-available main host is reasonable; Hosted Hub is the managed alternative. Preserve its data and plan for downtime and applicable service limits. [Self-hosting](https://paseo.sh/docs/hub/self-hosting) · [Hosted](https://paseo.sh/docs/hub/hosted). This research changes no installation, schedule, connection or execution permission.

### Adoption and test gates

1. Inventory hosts, tracker mappings, profiles and schedules. Pass the one-project local coordinator dry run and automatic-start pilot.
2. Add a second host and read-only main supervision, then acknowledged control requests. Test main-host downtime while remote work continues.
3. Evaluate Hub alongside core work on one test host: presence first, then one bounded coordinator trigger. Record exact versions, binding and Hub execution identities.
4. Test simultaneous schedule/event arrivals, lost launch responses, host/Hub outages, stale ownership, pauses and fresh reviewer selection. Require one worker per task claim, recoverable receipts and no unapproved delivery before expanding.

Hub adoption, sprint dates and forecasts are not prerequisites for the first automatic-start checkpoint.

## Work required before the scheduled pilot

### Task readiness and authorization

Define an explicit eligibility check: exact project/repository binding, understandable acceptance criteria, authorized scope, satisfied dependencies, available required tools and an allowed execution route. A task named Ready is insufficient on its own.

The policy should distinguish automatic planning/build/check/fix actions from user decisions and delivery authorization. Preserve authorization already granted for the task. Ask only for missing decisions or material scope changes. Do not infer authorization from a label, deadline or agent message.

For the first pilot, select one project and a small queue of low-impact tasks. Allow one active implementation task, keep delivery manual and pause automatic starts when the review queue reaches the agreed limit.

### Durable coordination and recovery

Implement task claims with exclusive ownership and bounded lifetime. Overlapping schedules must not launch the same task twice. Recovery must reconcile an expired claim with live agents before releasing or taking it over.

Handle busy agents, permission waits, open decisions, provider limits, offline hosts, failed checks and uncertain sends as distinct states. Read actual state before retrying a possibly successful write. Use bounded retries and backoff; escalate repeated failures with the recorded reason. Waiting is not automatically blocked.

Expose a pause control that stops new work and define separately whether active work continues or is interrupted. Preserve an operator-visible receipt for every start, resume, transition and recovery action.

### Profiles and workflow transitions

Create profiles for the responsibilities needed by the pilot, such as implementation and independent review, adding planning or UI profiles when useful. Read profile notes at launch and apply the supported settings. Profile names alone do not establish independence, permission or task ownership.

Update the lifecycle skills and coordinator contract together. Successful implementation should lead to validation; validation should lead to independent review; fixable findings should return to bounded repairs and fresh affected checks. A proposed initial limit is two repair rounds before escalation.

The reviewer uses `ocr delegate preview` for scope and `ocr delegate rule` for rules, with Gortex for relevant context. Account for reviewed and excluded files and bind the verdict to the examined revision. Missing OCR or required context must surface as a review gap, never a clean result.

### Timing from the first pilot

Start recording timing before forecasting. Define these boundaries consistently:

| Measurement | Start and end |
|---|---|
| Queue wait | Eligibility recorded to first actual work |
| Time to review | First actual work to a validated candidate ready for user review |
| Review wait | Review requested to the user's decision |
| Total cycle time | First actual work to verified delivery |
| Execution and check time | Observed agent/check intervals, separately from task elapsed time |
| Rework | Fix rounds, reopened tasks and material scope changes |

Reuse existing events wherever possible, extending their contract only when necessary. Keep attempts and intervals so a resumed run does not reset the task's original start. Parallel agents' execution time must not be mistaken for wall-clock duration. Mark missing telemetry as unknown. Do not backfill precise effort from file timestamps or an agent's guess.

## Testing stages and readiness gates

### Stage A Manual baseline testing now

Use a small reversible task in a test project or isolated worktree. Exercise Start, implementation, validation, independent review, a user decision and handoff. Exercise Resume separately. Capture the actual task/run, candidate revision, commands, results and observed UI behavior.

Test the Review navigation defect and the complete review journey on desktop and a compact/native client. Work that does not depend on the affected Review UI can be tested while that defect is being resolved. Keep delivery explicit and reversible for the baseline test.

**Exit:** one representative manual task reaches user review with traceable evidence, and the intended review surface can be opened, left and closed normally. This establishes a baseline, not unattended readiness.

### Stage B Scheduled dry run

Run the proposed coordinator against a fixture or selected task queue in observation mode. It reports what it would import, start, resume, wait on or escalate without dispatching work.

Include duplicate source items, missing criteria, wrong host/workspace, dependencies, working agents, open decisions and unavailable providers/tools.

**Exit:** every eligibility and routing decision matches the expected result, and simultaneous schedule invocations would not produce competing claims.

### Stage C Supervised scheduled pilot before sprint features

Enable the smallest real workflow: one project, one active implementation task, a configured implementation/review route and user-reviewed delivery. Begin with manually prepared ready tasks so tracker integration does not block testing. Add one known tracker source after the execution loop works.

Run a proposed pilot set of three to five small tasks covering a normal change, a bug with meaningful regression coverage and a task requiring clarification or repair. Observe the following scenarios in a disposable or controlled environment:

| Scenario | Required observation |
|---|---|
| Normal eligible task | Starts without pressing Start and reaches user review with evidence. |
| Overlapping coordinator checks | One claim and one launch; no duplicate agent or run. |
| Agent still working | No duplicate prompt, takeover or forced completion. |
| Coordinator interruption or missed response | State is reconciled and work resumes without losing history or replaying an uncertain action. |
| Failed validation | Delivery remains unavailable; bounded repair or escalation is recorded. |
| Independent review finds an issue | Fix and fresh verification are required before resolution. |
| Open decision or permission | Task waits visibly; no fabricated approval. Other eligible work follows the capacity policy. |
| Provider/tool/host unavailable | A clear operational result, bounded retry and no fallback to an unrelated host. |
| New code after review | Earlier review is recognized as stale for the changed candidate. |
| Timing | Execution, review wait and final delivery can be distinguished from evidence. |

**Exit:** the pilot tasks and recovery scenarios pass, there are no duplicate starts or unauthorized deliveries, all pauses are explainable, and the operator can trace each action. A successful small pilot permits gradual expansion; it does not prove every repository or provider behaves identically.

### Stage D Broader unattended operation

Expand projects, tracker sources and concurrency only after the supervised pilot. Observe operation over several working days, including host downtime and quota pressure. Verify that growing review queues limit new starts and that the pause/recovery controls work.

Track successful deliveries, rework, manual interventions, missed checks and unconfirmed actions. Define acceptable thresholds from the pilot before expanding further. Sprint/date features may be introduced independently; they are not prerequisites for stages A through C.

## Work that can follow the first pilot

| Capability | Next implementation scope |
|---|---|
| Scheduled tracker intake | Start with one supported source, then expand. Deduplicate by source identity, retain source links, report sync freshness and detect changed/canceled work. Do not silently replace the scope of an active task. |
| Host-specific tracker configuration | Each host uses Jira or Azure DevOps. Configure its project/query, access, ownership and field/status mapping; preserve source identities and links. Never import from another host's tracker configuration. |
| Dependencies and capacity | Support dependency ordering, independent parallel tasks and limits by project/provider. Keep review throughput in the capacity calculation. |
| Delivery automation | Define which accepted actions are authorized per project. Recheck the candidate, validate combined changes, preserve delivery receipts and handle partial failures. Update external status only after confirming the corresponding result. |
| Project environments | Provide repeatable setup, test data and runtime checks for each supported repository. Expand visual and native verification where relevant. |
| Learning loop | Record causes of rework and delays. Promote verified lessons into project guidance and regression coverage with evidence; do not automatically rewrite global instructions after every task. |
| Operational dashboard | Show working tasks, next eligible tasks and selection reasons, review queue, blocked/waiting reasons, last/next checks and source freshness. |

## Sprint dates and task deadlines

The agreed design uses separate dates:

| Field | Meaning and owner |
|---|---|
| Sprint end | Planning target for the selected group of tasks, set by the user or imported from the tracker. |
| Task due date | Optional specific commitment, set by the user or tracker; distinguish a target from a hard deadline. |
| Forecast completion | A calculated range based on remaining work, dependencies, history and capacity. |

A task without a due date uses its sprint end as a derived planning target. Do not copy that date into every task's stored due date. An earlier task deadline receives scheduling attention; contradictory dates are surfaced rather than silently rewritten. Work outside a sprint can use a due date or remain undated.

Forecasts include validation, repair and review wait. Start with broad ranges and an explicit limited-history label. Later, compare similar work by project and task type, show the number and recency of comparable observations, and retain earlier forecasts to measure calibration. Include incomplete and reopened work when assessing reliability so easy completed tasks do not distort the picture.

A forecast may change as evidence arrives. The coordinator must not move commitments merely to make the sprint appear on track. Flag risk early and explain the options, such as resolving a dependency, reviewing a waiting task or reducing scope.

## Implementation order and next checkpoint

1. Confirm the current Review fixes and manual workflow baseline. Record any remaining native/UI gaps.
2. Add readiness rules, exclusive task claims, profile routing, basic timing and guarded automatic transitions.
3. Pass a scheduled dry run, then run the supervised one-project pilot. This is the first automatic-start milestone and occurs before sprint/date work.
4. Add scheduled intake for one tracker and broaden recovery/capacity testing.
5. Add sprint dates, optional task due dates and calibrated forecasts after useful timing data exists.
6. Expand projects, integrations and explicitly authorized delivery automation based on observed reliability.

**The next testing checkpoint is a ready task reaching user review without a manual Start, with independent review evidence and recoverable state.** It does not require a sprint dashboard, scheduled tracker intake or accurate estimates.

Before enabling the pilot, select its project/tasks, native schedule cadence, profiles, operating hours, concurrency/retry limits and delivery boundary. These are configuration decisions for that pilot; this snapshot creates no schedules and changes no runtime permissions.

## Evidence and maintenance

The baseline draws on the current [plugin README](../plugins/mission-control/README.md), [agent workflow guide](agent-workflow.md), installed lifecycle skills, [OCR delegate skill](ocr-kit/open-code-review-delegate/SKILL.md), [software factory research](ocr-kit/research-report.md), live Paseo profile/schedule queries and the implementation history in this conversation. The [standalone user guide](user-guide/mission-control-user-guide.html) explains the current UI and its screenshot limitations.

Relevant external contracts are [Paseo schedules](https://paseo.sh/docs/schedules.md), [agent profiles](https://paseo.sh/docs/agent-profiles.md) and [Jira sprint dates](https://developer.atlassian.com/cloud/jira/software/rest/api-group-sprint/). Their availability does not establish that Mission Control has integrated them.

Update this snapshot after each testing stage with the date, exact candidate, passed and failed scenarios, evidence links and next gate. Individual task/run records remain authoritative for execution, decisions and delivery. Keep planned behavior visibly separate from observed behavior.
