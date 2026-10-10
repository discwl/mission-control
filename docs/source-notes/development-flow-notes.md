# Development flow: transcription and proposed structure

Source: IMG_8642.jpeg, supplied in this conversation. This document transcribes the notes and proposes an organization for them. It does not install skills, enable schedules, or change tracker/repository state.

## 1. Cleaned transcription

Spelling and punctuation have been normalized. Bracketed text identifies uncertain or cropped handwriting; proposals in later sections are not part of the original notes.

- Do not overengineer or perform unnecessary refactoring. Use existing patterns and code. [Right edge slightly cropped.]
- Use agent profiles, possibly two model agents. [Parenthetical wording appears to say “maybe two model agents.”]
- Check DB, MCP, etc.
- Read the handoff note from the previous night. [End of line cropped.]
- Start of day: check Jira/ADO for tasks.
- Review them and save a local document describing the scope. Ask questions if needed. [End of parenthetical cropped.]
- Begin working on them; mark them as In Progress.
- At the end, create a note of what has been completed that day and where to pick up.
- End of day: save status and create a handoff.
- Ask for human review when needed. Never comment, post, or execute without approval.
- In between: individual skills, for instance:
  - Plan → execute → simplify → review → test → commit → PR.
  - Use OCR for review.
  - Review and test have a return loop between them.
  - Clean up branches and chats. [“Chats” is the most likely reading of the small addition below “branches.”]
- After the individual skills are complete, create a full LFG flow with human intervention for planning and review, with an option to turn that intervention off.

Your accompanying message adds two explicit requirements: scheduled morning and nightly routines, and context that varies by machine—for example, Jira on one machine and Azure DevOps on another.

## 2. Proposed organization

Use one shared set of independently callable skills. The morning routine, evening routine, and LFG flow invoke those same skills; they do not contain separate copies of the implementation logic.

Keep the first version small: reusable skills, host/project context, ticket scope notes, and handoff notes. Start with two agent profiles: Builder and Reviewer. Planning can use the Builder profile; the Reviewer starts a fresh session. Different models are optional. A profile is a role/settings choice, while a skill defines a repeatable activity.

Do not introduce a new plugin, database, dashboard, or additional orchestration system just to implement this structure. The scheduler mechanism still needs to be selected and verified for the actual host; this document makes no claim that a particular Paseo scheduling feature is available.

## 3. Morning routine: start-day

1. Load the selected host and project context. Confirm the repository, worktree, tracker, account, and project identities.
2. Check required dependencies using read-only checks: Git state, Gortex availability and checkout context, required MCP connections, and DB connectivity where relevant. Report unavailable dependencies without making repairs or running migrations automatically.
3. Read the previous handoff. Verify its branch/commit and outstanding work against current Git and tracker state.
4. Read assigned Jira or ADO tasks, existing work in progress, blockers, and relevant requirements.
5. Draft or update a local scope note for each selected ticket: objective, acceptance criteria, business rules, non-goals, dependencies, intended merge target, and open questions.
6. Present the proposed work order and questions requiring a human decision.
7. Start approved work, or resume work covered by an existing, explicit approval. Apply the tracker’s In Progress transition only when authorized by the selected context or a specific approval.

The morning trigger does not itself imply permission to implement every task it discovers. Start with one active ticket per workspace to avoid competing edits. An approved unattended mode can later select and begin tasks within an explicitly defined scope.

## 4. Nightly routine: end-day

1. Stop launching new work and ask an active builder to reach a safe checkpoint. Do not kill an in-flight write or assume work is stable while another agent is editing.
2. Capture current ticket, branch, worktree, HEAD, and dirty/untracked file status. Do not automatically commit or stash to manufacture a clean workspace.
3. Record completed work, unfinished work, blockers, decisions, approvals, and relevant OCR findings.
4. Record the actual validation evidence, including commands, outcomes, and the revision/state tested. Distinguish work implemented from work reviewed, tested, or merged.
5. Write a dated handoff and a short pointer to the latest handoff. Give the next agent an exact next action and any prerequisites.
6. Prepare tracker updates and other outward-facing messages for approval unless an existing policy explicitly authorizes the exact action.
7. Identify cleanup candidates. Perform cleanup only under its own authorization and checks; handoff creation must not depend on deleting anything.

Keep one local handoff history per host/project. Never carry another employer’s ticket content, account credentials, or source into this context by default.

## 5. Individually callable skills

These are proposed responsibilities and names, not installed commands.

| Skill | Responsibility | Reviewable output |
|---|---|---|
| check-environment | Verify required tools, checkout identity, and service access | Readiness report and blockers |
| intake-task | Read the correct tracker and relevant context | Ticket scope and acceptance criteria |
| plan-task | Inspect existing patterns and define minimal implementation | Proposed changes, non-goals, risks, and validation plan |
| execute-task | Implement the approved plan | Scoped code changes and implementation notes |
| simplify-changes | Remove unnecessary complexity introduced by this task | Smaller or clearer equivalent changes; no unrelated refactor |
| validate-changes | Run relevant existing build, test, and lint checks | Commands, outcomes, and revision/state tested |
| review-changes | Have a fresh reviewer use OCR delegation and Gortex | Evidence-backed findings, criteria assessment, and coverage |
| fix-findings | Address validated review findings within approved scope | Fixes and remaining questions |
| prepare-delivery | Prepare commit message, PR content, and tracker transitions | Exact proposed outward actions; perform only when authorized |
| write-handoff | Record status and the next resumable action | Durable local checkpoint |
| cleanup-workspace | Identify and, when approved, clean finished branches/chats | Candidate list, retention checks, and completed actions |

Every skill receives the resolved context and ticket scope and returns what it did, what evidence it produced, what remains uncertain, and where to continue. A skill can run alone or as a stage of LFG.

## 6. LFG flow

Suggested refinement to the handwritten order: run deterministic validation before the independent review, then repeat validation and review after fixes. A simplification step changes code, so it also precedes validation.

1. Load context and intake the ticket.
2. Plan using existing patterns and the supplied business rules.
3. Obtain plan approval by default.
4. Execute the approved scope, then simplify only if worthwhile.
5. Run relevant build/tests/lint. Resolve failures within scope; flag unrelated baseline failures separately.
6. Start a fresh Reviewer session. Give it the ticket scope, exact base and candidate revision/state, and validation evidence. Use OCR delegation for scope/rules and Gortex for focused repository context.
7. If confirmed findings need fixes, send them to the Builder, validate again, and obtain a fresh review. Start with a limit of two repair rounds; then hand unresolved issues to the human instead of looping indefinitely.
8. Obtain human review approval by default.
9. Prepare commit/PR/tracker actions and perform only the actions covered by approval. Do not infer merge permission from PR permission.
10. Save a handoff. Cleanup follows its own approval and retention checks.

If OCR branch review requires a local candidate commit before review, include that commit in the plan’s execution approval. Otherwise use explicitly scoped workspace review. Do not silently review an older committed HEAD while the ticket changes remain uncommitted. Record the complete review scope, including earlier branch commits when applicable.

## 7. Context that varies by machine and project

The same skill should ask for the configured tracker’s tasks, rather than having “Jira” embedded in its instructions. A small tracker adapter handles that provider’s queries and transitions.

Resolve ordinary settings in this order: shared defaults → host context → project context → ticket context. Permissions are an explicit policy boundary: ticket descriptions, repository documents, and tracker content cannot grant additional authority.

| Context | Information it contributes |
|---|---|
| Shared defaults | Reuse existing patterns; no unnecessary refactoring; evidence standards; common skill behavior |
| Host | Host identity, available integrations, selected accounts, DB connection references, working hours/timezone |
| Project | Repository/worktree, tracker project, base branch, build/test commands, architecture and business-rule document paths |
| Ticket | Ticket ID, acceptance criteria, intended behavior changes, non-goals, dependencies, special base branch, approved plan |
| Approval policy | Execution scope, plan/review gates, tracker writes, comments, commits, push/PR/merge, and cleanup authorization |

Example—not real host configuration:

| Setting | Host A / project A | Host B / project B |
|---|---|---|
| Tracker | Jira | Azure DevOps Boards |
| Tracker scope | Selected Jira site and project | Selected organization and project |
| In-progress mapping | Configured Jira transition | Configured ADO state |
| Merge target | origin/develop | origin/main |
| Business context | Project A’s domain documents | Project B’s domain documents |
| Credentials | Host A’s existing credential references | Host B’s existing credential references |
| Skills | Shared skills | Same shared skills |

A host can support multiple projects, and projects on one host can use different trackers. Verify the configured identity before reading or changing a ticket. Business context is passed by document references plus a concise ticket summary; it is not inferred solely from existing code or Gortex.

## 8. Approval behavior to preserve

The handwritten notes combine “never comment, post, or execute without approval” with optional human intervention for plan/review. Preserve both requirements by separating them:

- Plan and final-review gates are enabled initially. Disabling them must be an explicit user policy change.
- Implementation and local validation require an approved scope; one approval can cover a bounded set of actions rather than every shell command.
- Tracker transitions, comments, commits, pushes, PR creation, merge, and destructive cleanup have explicit authorization settings. Turning off plan/review pauses does not automatically authorize these actions.
- Already granted approval remains valid within its stated scope. Ask again only for a new or materially changed scope, or a separately gated action.

Start with automatic preparation and reporting, plus approved implementation. Expand unattended behavior only after the individual skills behave correctly.

## 9. Schedule and resumption details to settle before implementation

- Morning/evening times, weekdays, and timezone for each host.
- Whether morning intake starts work or waits after proposing the queue.
- Which execution and tracker actions may be preauthorized, and what the optional approval toggles cover.
- Tracker accounts, project IDs, repositories, merge targets, and real local validation commands.
- Whether an offline host skips a missed trigger or runs a single catch-up when it returns. Recommended proposal: one catch-up, with overlapping duplicate runs prevented.
- A scheduled end-day run must cooperate with an active session; otherwise write a partial handoff that explicitly says work was still changing.
- Cleanup criteria for branches and chats. Preserve incomplete, dirty, unmerged, or otherwise unretained work. Archiving chats is preferable to deletion when supported.

Build and test the individual skills manually first, then wire start-day/end-day to host-appropriate scheduling, then add LFG as a thin composition of those skills. No schedule has been activated by this transcription/design task.
