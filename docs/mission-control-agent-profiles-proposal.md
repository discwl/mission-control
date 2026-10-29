# Mission Control agent profiles — proposal

Status: Draft for discussion, updated October 29, 2026. Provider preferences are collected for all nine hosts. Exact phase assignments, model IDs, reasoning settings, and backup behavior remain to be finalized. No host profiles, mappings, permissions, or running agents were changed while preparing this document.

This revision replaces the initial Codex-first proposal with the user's host-by-host preferences. Model availability in the first table is user-reported. The separate machine inventory was captured October 28 at approximately 10:52 PM America/Los_Angeles (October 29, 05:52 UTC); it is dated evidence, not a current health report. Personal, CNS, AACN, and PN responded then. The other five hosts still need runtime verification before rollout.

## Confirmed host preferences

| Host | Primary provider / route | Models reported available | Backup / exclusions |
| --- | --- | --- | --- |
| Personal | Claude Code and Codex | Claude: Fable 5.1, Opus, Sonnet. Codex: Astra, Sol 6.1, other mid-tier ChatGPT models. | Both are routine choices. OpenCode is occasionally used, but no OpenCode profiles are wanted. |
| CNS | GitHub Copilot directly in Paseo | Astra, Sol 6.1, Opus 5.5, Sonnet 5.5, others. | OpenCode was for testing. Codex is installed but rarely used because of restrictive five-hour limits; exclude it from routine assignments. |
| AACN | Codex | Astra and Sol 6.1. | Copilot also available, with Sol 6.1 and Sonnet 5.5 only. Verify whether its actual Paseo route is direct Copilot or OpenCode. |
| PN | Codex | Exact preferences not specified; the earlier catalog included Astra and Sol 6.1. | Claude Code is being considered for later. Keep current profiles Codex-only. |
| WestCap | Claude Code | Opus and Fable 5.1 confirmed. | Codex when Claude's allowance runs out. Exact versions and Codex models still need checking. |
| Chipotle | GitHub Copilot | Claude and ChatGPT models except Fable. | No backup specified. Exact provider route and IDs still need checking. |
| CareSource | GitHub Copilot | Models except Astra and Fable. | Claude Code, with models up to Opus 5.5, when Copilot credits run out. |
| Xendee | Claude Code | Exact Claude model selection still to verify. | Codex with its full available model selection when Claude credits run out. |
| JCI | OpenCode using the JCI gateway's Bedrock models | JCI-prefixed models, including Sol 6.1 and Opus 5.5. | First: Copilot through OpenCode, up to Astra. Then: OpenCode Go, mainly DeepSeek v4+ Pro. |

“All models” describes the user's selection within that route, not an exhaustive verified catalog. Exact provider IDs, gateway aliases, versions, and reasoning controls must come from each host. Do not invent a JCI-prefixed ID or replace a gateway alias with a direct provider ID.

## Roles and responsibilities

Native Paseo profiles define provider, model, reasoning, and permission mode. Mission Control selects the profile for each managed phase, supplies task instructions, and checks saved evidence and human decisions. Host defaults provide the baseline; project overrides refine them, and task overrides take precedence.

| Native profile / role | Mission Control mapping | Required result |
| --- | --- | --- |
| Existing coordinator chat | Existing Personal orchestrator; no new phase mapping | Track tasks and workers, explain status, route decisions, and delegate the next authorized phase. Keep current chat settings. |
| MC Planner | `planner` | Inspect the task and existing patterns; save a readable plan with scope, acceptance checks, non-goals, and a versioned approval proposal. |
| MC Builder | `builder` for implementation and fixes | Implement the approved scope using existing patterns; fix substantiated findings and record remaining issues. |
| MC Validator | `validator` | Run project checks against the exact candidate and record actual results and untested areas. Use a fresh stage even when it shares the builder's model. |
| MC Reviewer A | `reviewer` | Use OCR for file selection and rules, review independently with Gortex context, and save findings plus complete coverage evidence. |
| MC Reviewer B | `reviewer2`, when enabled | Review the same candidate independently using a different model, preserving findings and disagreements. |

The heartbeat timer needs no model profile. When supervision wakes an orchestrator, that chat uses its existing configuration. These mappings do not add automatic model selection for heartbeat, intake, or delivery.

## Phase candidates for discussion

These are proposed starting choices, not approved assignments or benchmark results. Primary phases stay on the preferred provider. A provider reserved for quota exhaustion is not used for routine second reviews without a separate choice to do so.

| Host | Planner | Builder | Validator | Reviewer A | Optional Reviewer B |
| --- | --- | --- | --- | --- | --- |
| Personal | Codex Astra; Claude Fable 5.1 alternative | Codex Sol 6.1; Claude Opus alternative | Codex Sol 6.1 | Claude Opus | Codex Astra |
| CNS | Copilot Astra | Copilot Sol 6.1 | Copilot Sonnet 5.5 | Copilot Opus 5.5 | Copilot Astra |
| AACN | Codex Astra | Codex Sol 6.1 | Codex Sol 6.1 | Codex Astra | Copilot Sonnet 5.5, through its verified route |
| PN | Codex Astra | Codex Sol 6.1 | Codex Sol 6.1 | Codex Astra | Codex Sol 6.1, fresh reviewer agent |
| WestCap | Claude Fable 5.1 | Claude Opus | Claude Opus, fresh validation stage | Claude Fable 5.1 | Claude Opus, fresh reviewer agent |
| Chipotle | Copilot Astra | Copilot Sol 6.1 | Copilot Sonnet 5.5 | Copilot Opus 5.5 | Copilot Astra |
| CareSource | Copilot Opus 5.5 | Copilot Sol 6.1 | Copilot Sonnet 5.5 | Copilot Opus 5.5 | Copilot Sol 6.1, fresh reviewer agent |
| Xendee | Claude model pending catalog | Claude model pending catalog | Claude model pending catalog | Claude model pending catalog | Second distinct Claude model, if available and selected |
| JCI | JCI gateway Opus 5.5 | JCI gateway Sol 6.1 | JCI gateway Sol 6.1 | JCI gateway Opus 5.5 | JCI gateway Sol 6.1, fresh reviewer agent |

JCI's primary row runs entirely through OpenCode and the JCI gateway; Copilot Astra belongs to its backup route. CareSource has no Astra/Fable assignment. AACN has no Copilot Opus/Astra assignment. Personal and CNS have no routine OpenCode assignment. PN has no current Claude assignment.

Start with high reasoning for planning, implementation, and review where the route supports it, and medium for routine validation. Verify the actual controls; a label supported by one provider may not exist on another. Complex tasks can use a deliberate override.

The Astra/Sol split is informed by [OpenAI's model-selection guidance](https://developers.openai.com/api/docs/guides/model-selection), which describes Astra for deep analysis and Sol for complex work where time and cost matter. It recommends testing representative tasks and measuring review and repair effort. Host preferences and limits also inform this proposal. Claude and DeepSeek choices require their own workflow pilots; no comparative benchmark claim is made here.

## Backup order and quota handling

| Host | Described usage / preference | Still to decide |
| --- | --- | --- |
| Personal | Claude Code and Codex are both routine options. | Phase defaults and whether to switch when one reaches its limit. |
| CNS | Direct Copilot; avoid routine Codex because of its five-hour limit. | No automatic backup requested; pause if the selected route is unavailable. |
| AACN | Codex primary; Copilot Sol 6.1/Sonnet 5.5 also available. | Whether Copilot is a quota backup as well as an optional second reviewer. |
| PN | Codex only. | Wait for capacity if unavailable; consider Claude later. |
| WestCap | Claude Code → Codex when Claude's limit is reached. | Backup profiles and how a switch is initiated. |
| Chipotle | Copilot. | No backup specified. |
| CareSource | Copilot → Claude Code, up to Opus 5.5. | Backup profiles and how a switch is initiated. |
| Xendee | Claude Code → Codex. | Exact models for both sets and how a switch is initiated. |
| JCI | OpenCode/JCI gateway → OpenCode/GitHub Copilot → OpenCode Go/DeepSeek v4+ Pro. | Exact IDs, per-project route selection, and how a switch is initiated. |

These arrows record preferred backup order. Native role profiles and current single-profile phase mappings do not by themselves implement ordered, automatic quota failover. This document does not enable it.

For the first rollout, create the agreed primary profiles and only the backup profiles we decide to use. Select a backup deliberately for a new managed phase attempt after saving the prior attempt's state. Preserve the task, approved scope, workspace, candidate, and actual agent identity. Do not repeat completed publication actions or let two builders work on the same candidate concurrently.

If automatic failover is later built, restrict it to configured routes and genuine capacity failures. Authentication errors, failing tests, missing tools, and approval waits should remain visible problems rather than trigger a provider switch. Record why the route changed and which model actually ran. A model available through one route does not prove the project's tools and context work through that route.

JCI stays in the OpenCode app across all three routes; the model route changes. Use actual gateway IDs and verify alias normalization before counting routes as different models. DeepSeek v4+ Pro is the user's label until the host catalog confirms it. Test workflow tools and required evidence before assigning it a managed phase. If only one distinct model remains available, a task requiring two-model review must wait or receive an explicit review-policy change; two runs of the same model cannot satisfy it.

## One-model and two-model review

Recommended default for discussion: one fresh Reviewer A. Enable two-model review explicitly for projects or tasks where the added scrutiny is useful, such as accounting, payments, authorization, or migrations. Mission Control does not currently classify risk and enable it automatically.

Each reviewer uses the same candidate and OCR-selected scope, performs its own review, and saves coverage and limitations. A fresh reviewer can use the builder's model, but the two reviewer slots must use different normalized models. A change of provider route alone does not establish diversity.

Keep both reports and disagreements. One passing report does not erase another report's findings. Fixes that change the candidate require validation and review evidence matching the new candidate before the next human decision. Pilot one- and two-reviewer configurations on representative work; compare useful findings, missed defects, false positives, completion time, and repair work.

## Tools and shared instructions

Provider choice affects tool configuration. Native profiles currently do not provide a Mission Control per-role MCP allowlist. Provider and workspace configuration determines tool exposure; role instructions are not a complete access-control boundary.

| Phase | Required capabilities | Project-specific additions |
| --- | --- | --- |
| Coordinator / intake | Paseo workers, Mission Control tasks/decisions, intake/context skills | Relevant Jira, ADO, or repository tracker reads |
| Planner | Gortex, project instructions, `check-environment`, `plan-task`, task artifact access | Tracker reads and application/UI context |
| Builder / fixes | Gortex impact/edit workflow, `execute-task` / `fix-findings`, Git/build tools | Browser, database, or service tools needed within scope |
| Validator | `validate-changes`, project tests/build/lint, task artifact access | UI checks and approved test-environment integrations |
| Reviewers | `review-changes`, `open-code-review-delegate`, OCR CLI/rules, Gortex, exact candidate | Focused checks to substantiate findings |
| Delivery preparation | `prepare-delivery`, candidate and review evidence | Correct repository/tracker identity and separate authorization |

OCR resolves deterministic scope and rules; the selected reviewer model performs the review. Installing OCR or mentioning it in a prompt is not evidence that it ran. Both reviewer slots must satisfy the saved review contract.

Keep these instructions shared across providers:

- Work from the approved task, acceptance criteria, and non-goals. Reuse existing patterns and dependencies. Make the smallest change that meets the criteria.
- Avoid speculative abstractions, unrelated cleanup, and expanded requirements. Bring a material scope change back for a revised plan decision.
- Preserve unrelated work. Tie plans, checks, reviews, and decisions to the exact task and candidate. State missing evidence plainly.
- Reviewers investigate and report; builders fix. Reviewers must not silently change application code while declaring it reviewed.
- Explain approvals in human terms: problem, intended behavior, scope, checks, risks, and the exact decision. Keep technical evidence separately accessible.
- Plan approval authorizes the described implementation. Code acceptance and publishing permission are separate decisions. Prepare PRs and tracker comments, then wait for approval before submitting. Live financial, production, deployment, or other external mutations need their own authorization.

Permission modes remain a rollout decision. For Codex, pilot `auto` (Default Permissions) with workspace and task-artifact paths. For Claude, inspect existing permissions and choose a mode that supports the agreed local workflow. For direct Copilot, discover its supported modes. For OpenCode, verify `build` and tool permissions for each route. Do not silently change existing agents to unrestricted modes.

A role named Planner is not the same as a provider's `plan` permission mode. Claude/OpenCode plan modes restrict tools or edits, while our planner must save versioned artifacts. Reviewers also need to save reports. Verify actual permissions rather than choosing by name. Permission prompts should appear as Needs you; unattended operation does not imply publishing permission.

## Dated machine inventory and remaining checks

These observations are from October 28, 2026, at about 10:52 PM Pacific. Recheck them; they do not override the user's provider preferences.

| Host | Observed setup | Follow-up for this revision |
| --- | --- | --- |
| Personal | Claude/Codex advertised; Codex listed all ten workflow/OCR skills. Gortex 0.64.11; OCR 1.13.3. | Claude's global inventory lacked those ten skills; check actual workspace exposure before adding anything. Four global OCR rules were missing; check repository rules. Preserve eight existing Copilot/OpenCode profiles, but exclude them from these defaults. GitHub CLI was not found on Paseo's PATH. |
| CNS | Codex/OpenCode catalogs responded; direct Copilot discovery returned `Authentication required`. Gortex 0.64.11; OCR 1.12.9; four global rules installed. | Reverify preferred direct Copilot, its catalog and workflow tools. The old discovery failure does not justify substituting Codex. Codex's `cua_repl`/`node_repl` commands were missing, but Codex is outside the primary plan. Check browser tooling on the actual Copilot route. |
| AACN | Codex/OpenCode advertised; workflow/OCR skills, Gortex, Azure/ADO, Playwright configured. Gortex 0.64.11; OCR 1.13.3. | Resolve the Copilot route before creating its Sonnet profile. ADO CLI reported no sign-in for AACN-DPS; check the intended delivery route separately. Preserve one unmanaged OCR rule. |
| PN | Codex and workflow/OCR skills listed. Gortex 0.64.10; OCR 1.12.13; four global rules. GitHub CLI account `nvartpn`. | Stripe reported sign-in needed. Some saved signed-in MCP entries returned HTTP 401 to probes; test the authenticated path. Confirm repository authorization. Claude remains a future option. |
| WestCap, Chipotle, CareSource, Xendee, JCI | No completed runtime inventory in that snapshot; some hosts were offline or connecting. | User preferences are now recorded. Catalogs, permissions, skills, OCR, Gortex, and project tools still need verification. This does not claim they remain offline today. |

The inventory covers global configuration, not every project-local or Paseo-injected binding. Finding a command does not prove an MCP server starts; an unauthenticated HTTP 401 does not prove saved credentials fail. Catalog discovery does not prove quota or successful execution. Verify build SDKs, databases, browser sessions, and account permissions where needed.

The setup checker called some OCR versions outdated because they differed from its 1.12.9 pin. Personal/AACN's 1.13.3 and PN's 1.12.13 were newer. Do not downgrade merely to clear the indicator; check compatibility and version policy.

Known IDs from that snapshot include Codex `gpt-6-astra` and `gpt-6.1-sol` on Personal/AACN/PN, and native Claude `claude-opus-5-5` on Personal. The old CNS Codex catalog's absence of Sol 6.1 does not describe CNS's Copilot catalog. Fetch current route-specific IDs before saving profiles, especially for direct Copilot and JCI aliases.

## Existing tasks and rollout

New managed phase launches use the resolved profile mapping. Running agents retain their settings; existing chats, decisions, and history remain intact. Existing tasks can enter at the next appropriate phase. Reuse scope and evidence only while they match the current plan/candidate. Do not relabel historical reviews as two-model reviews.

Keep the coordinator in its Personal chat and workers in the task's owning remote workspace. Preserve one-way connectivity: do not register Personal remotely. Completions return through the native worker relationship. Work started outside the managed launcher needs deliberate adoption.

After finalizing the proposal:

1. Recheck selected routes on every host, including exact models, reasoning controls, authentication, skills, and project tools. Complete the five outstanding runtime inventories.
2. Agree on phase models, review count, permissions, and backup profiles. Keep automatic failover a separate implementation choice.
3. Export profiles/mappings for rollback. Create only agreed profiles using each host's own IDs; preserve unrelated profiles and active agents.
4. Test a harmless fixture through plan approval, implementation, validation, OCR-backed review, and a separate delivery decision. Verify actual model/agent identity, coverage, stale-candidate rejection, and attention/completion routing. External publication is unnecessary for this fixture.
5. Save agreed defaults/overrides, pilot one already-authorized real task, and adjust from outcomes before broad use. Restore mappings if configuration fails; preserve task history and unrelated work.

## Decisions for our next discussion

| Decision | Current proposal |
| --- | --- |
| Provider selection | Follow the confirmed host table; no uniform Codex default |
| Phase models | Finalize the candidate table per host; fill Xendee's remaining model details |
| Personal's routine choices | Choose between Astra/Fable 5.1 for planning and Sol/Opus for implementation, retaining both providers as options |
| Review count | One fresh reviewer by default; two configurable per project/task |
| Backup use | Preserve the user's order; select backups explicitly first, discuss automatic quota failover separately |
| Reasoning | High for plan/build/review and medium for routine validation where supported, subject to pilot results |
| Existing orchestrators | Keep current chats and settings |
| Publication | Prepare the exact action and wait for approval |

Provider preference collection is complete. Runtime verification and final phase/backup choices remain before host configuration.
