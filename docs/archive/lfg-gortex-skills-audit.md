# LFG workflow: Gortex tool and skill audit

Reviewed 12 September 2026.

## Recommendation

Build a small LFG skill package for the workers and a durable Paseo controller for the workflow. Keep Gortex as the code graph and context engine. Adapt individual practices from GitNexus, Compound Engineering, and Superpowers instead of activating all three complete orchestration systems.

The target flow is intake → planning → human plan approval → implementation and validation → independent review with a bounded fix loop → human code review → ready for commit. Do not automatically commit, push, open a PR, or publish review comments.

This is a source audit and proposed design. It does not establish what is installed or enabled on your hosts, or validate behavior against your repositories. No tools were installed and no project code was changed.

## Source basis and coverage

Gortex was examined at release **v0.64.3**, newer than the v0.64.1 mentioned earlier in the conversation. The other projects were examined at their current repository heads, pinned below. Their current skills can include changes after the latest release.

| Project | Source examined | Latest release reported by its repository |
| --- | --- | --- |
| Gortex | [v0.64.3](https://github.com/zzet/gortex/tree/v0.64.3/) | [v0.64.3](https://github.com/zzet/gortex/releases/tag/v0.64.3), 2026-09-10 |
| Compound Engineering | [f050478dfc2b](https://github.com/EveryInc/compound-engineering-plugin/tree/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/) | [compound-engineering-v3.24.0](https://github.com/EveryInc/compound-engineering-plugin/releases/tag/compound-engineering-v3.24.0), 2026-08-31 |
| Superpowers | [b36e0829c6d0](https://github.com/obra/superpowers/tree/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/) | [v6.3.0](https://github.com/obra/superpowers/releases/tag/v6.3.0), 2026-08-12 |
| GitNexus | [68c42009df8c](https://github.com/abhigyanpatwari/GitNexus/tree/68c42009df8ce4dd0f59042cbbfede9aa3784096/) | [v1.6.11](https://github.com/abhigyanpatwari/GitNexus/releases/tag/v1.6.11), 2026-09-04 |

Coverage: Gortex's 21 compact MCP domains, the explicit legacy-to-compact registry, the unified analysis-kind catalog, all 21 bundled skill bodies, the two bundled Claude subagent definitions, and relevant implementation handlers. Also reviewed: all 35 top-level Compound Engineering skill files, all 14 Superpowers skill files, and the 12 GitNexus plugin skill files, with deeper inspection of their planning, handoff, execution, and review references.

The appendices list the complete static catalogs examined. Counts describe source inventory, **not a guarantee that every handler is available in an installed daemon**. Language servers, providers, index enrichment, configuration, and selected tool profiles affect availability. Repository-generated Gortex module skills are specific to the user's index and cannot be enumerated without that repository.

Primary Gortex references: [compact API contract](https://github.com/zzet/gortex/blob/v0.64.3/docs/mcp-facade-v1.md), [mapping registry](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/facade_registry.go), [skill bodies](https://github.com/zzet/gortex/blob/v0.64.3/internal/agents/commands_bodies.go), and [shared skill protocol](https://github.com/zzet/gortex/blob/v0.64.3/internal/agents/commands_content.go).

## The process and the Gortex calls to use

Notation below is descriptive: `change(impact)` means compact tool `change` with `operation: "impact"`. `analyze` uses `kind`. This is **not** a complete JSON request template; request the operation's actual schema through `capabilities` before implementation. Compact requests must not blindly reuse legacy arguments.

| Stage | Gortex calls | Other evidence and exit condition |
| --- | --- | --- |
| Controller preflight | `capabilities`; `workspace(info, index, checkouts)`; checkout-view diagnostics when needed | Resolve Paseo host/workspace, repository root and base commit. Verify exact checkout routing and adequate graph freshness. A degraded result is visible, not silently treated as complete. |
| Intake | `explore(task, context)`; `search(symbols, text, files, artifacts)`; `read(source, file, symbols, artifact)`; `relations(callers, dependencies, dependents)` | Read the ticket/spec, parent feature, relevant linked issues and comments. Use bounded, read-only SQL/cloud queries when needed. Produce a cited evidence brief with acceptance criteria and unresolved questions. |
| Targeted deeper intake | `trace(call_chain, path, flow, taint, cfg)`; relevant `analyze` kinds such as `routes`, `config_readers`, `sql_call_sites` | Use a specific question to justify each deeper query. Graph relationships are hypotheses until important behavior is checked in source. Stop once the implementation questions are answered. |
| Planning | `change(impact, api_impact, verify, tests)`; `read(editing_context)`; `relations(implementations, usages)`; targeted `analyze(contracts)` | Define the smallest sufficient change, concrete files/symbols, test scenarios, excluded work and risks. Map each change to an acceptance criterion. Escalate material missing requirements before seeking approval. |
| Human plan approval | Optional `session(planning_mode)` is supplementary | The controller records approval of a specific plan revision and source baseline. No implementation agent starts before this gate succeeds. |
| Implementation | `read(editing_context)`; `change(preview)` where useful; `edit(file, symbol, write, batch)`; `change(receipt, diagnostics)` | Use the approved Paseo worktree. Source writes follow Gortex's supported editing protocol. Check preconditions and publication receipts; resolve pending writes before retrying. Refactors require an explicit plan reason. |
| Validation | `change(detect, tests, guards, contract, diagnostics)` | Inventory staged, unstaged and untracked files independently of Gortex's diff. Run the repository's actual build/tests and relevant integration checks. Store command, exit status, output reference, source snapshot, and environment. |
| Independent code review | `review(pack, run, diff_context)`; `change(impact, tests)`; targeted `read` and `relations` | Review the real code against both requirements and the approved plan. Return separate specification and quality verdicts. Treat graph findings as evidence, not final judgment. Account for every new file. |
| Fix and re-review | Same narrowly scoped edit and review calls | Fix confirmed in-scope findings, rerun affected verification, and re-review the repair plus open findings. Proposed limit: two unsuccessful fix rounds before human adjudication. |
| Human code review | `response(export_context)` optionally helps assemble evidence | Show plan, complete diff, test evidence, deviations and review disposition. Approval applies to the reviewed source snapshot. Stop ready for commit/push/PR. |
| Optional learning | `recall` during later intake; `remember(note, memory)` only through a controlled learning step | Save verified, reusable lessons. Keep unfinished-branch behavior as a candidate rather than a global rule. Do not automatically suppress findings or acknowledge risks. |

The scope of Jira intake should follow relevance: the parent feature and linked tickets that affect requirements, interfaces, dependencies or prior decisions. It should not recursively read an entire project. Likewise, inspect database schemas, procedures, representative bounded results and relevant cloud configuration only to answer concrete task questions. Gortex's SQL/config graph is useful for finding what to inspect; it cannot establish the current live database or cloud state.

`explore(plan)` is a next-tool-call planner (`plan_turn`), **not a replacement for the implementation-planning agent**.

## Important implementation corrections

### Review the actual worktree, and account for new files

In v0.64.3, `change(detect)` delegates to Git diff and explicitly discloses that untracked and ignored files are not observed. `scope: "all"` does not change that. The controller needs a complete task file manifest, including untracked content, renames, deletions and staged/unstaged states. It must distinguish task-owned files from unrelated existing dirt. Ignored build output is not automatically part of the review, but a newly created source file hidden by an ignore rule must not disappear unnoticed.

`review(pack)` accepts pasted diffs, but that path skips contract, guard and test gates that require indexed symbol IDs. Run the worktree-based review with explicit scope for the ordinary graph gates. Use a complete patch as supplemental review input. For new files, independently ensure their source is reviewed and their indexed symbols are included in applicable explicit checks after graph publication. A pasted diff alone is not an equivalent full graph review.

Sources: [change detection](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_analysis.go), [review handler and schema](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_review.go).

### Workflow modes are guidance, not durable approval enforcement

Gortex's workflow and planning modes are useful session aids. They are per MCP session, can be advanced or stopped by the agent, and do not persist the user's approval across four separate Paseo agents. The verification phase also allows edits. Use a controller-owned state record and provider/harness permissions for actual boundaries.

The compact MCP profile is a closed 21-name surface and ignores profile `allow`/`deny` deltas. Do not assume a configuration like “compact minus edit” enforces read-only access. Restrict calls at a supported provider/harness boundary or deliberately choose a compatible alternative Gortex profile. A prompt, UI button, or daemon's ability to launch an agent is not by itself an authorization barrier.

Sources: [workflow modes](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_workflow.go), [planning mode](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_mode.go), [compact contract](https://github.com/zzet/gortex/blob/v0.64.3/docs/mcp-facade-v1.md).

### Use graph evidence together with repository-specific verification

Review-pack LLM assistance is optional and defaults off. Its generated verification-command language selector in this release recognizes Go, Python, TypeScript, JavaScript and Rust, with no C#/.NET branch. For C# projects, establish the correct existing `dotnet`, MSBuild, VSTest or other CI commands during intake. Do not assume the generated command covers that project. This limitation concerns command selection, not all Gortex C# graph support.

Likewise, no dependent edges, a low impact score, or a clean deterministic review does not prove a change is safe. Confirm relevant dynamic behavior, integration boundaries and acceptance criteria through source and tests. If required evidence is unavailable, return `blocked` or explicitly incomplete validation rather than a passing result.

Source: [review-pack implementation](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_review.go).

### Be explicit about checkout state, writes and tool availability

- Require the correct worktree view for correctness-sensitive queries and honor freshness/degradation metadata. Do not silently substitute the primary checkout's graph.
- `explain_view` exists as a legacy tool but has no compact operation mapping in this release. Use controller-side `gortex repos explain-view` diagnostics or a compatible legacy profile; do not invent `workspace(explain_view)`.
- Mutation previews describe proposed changes. A successful source edit can still have pending graph publication. Use mutation receipts and record the outcome before retrying a write.
- Version/precondition hashes and physical-evidence hashes have different contracts; preserve their algorithm and meaning rather than treating all digest fields interchangeably.
- Gortex's native MCP skills require native MCP. Their CLI skill is for a harness deliberately using the CLI, not an automatic fallback when MCP breaks. A Paseo plugin backend may separately use the CLI for its own supported diagnostics.
- Graph analysis and semantic refactor availability differ by language. In particular, documented move/inline refactors are not a blanket promise of equivalent C# support.

Sources: [registry](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/facade_registry.go), [CLI](https://github.com/zzet/gortex/blob/v0.64.3/docs/cli.md), [MCP reference](https://github.com/zzet/gortex/blob/v0.64.3/docs/mcp.md), [shared skill instructions](https://github.com/zzet/gortex/blob/v0.64.3/internal/agents/commands_content.go).

## All 21 bundled Gortex skills: disposition

The role determines when to load a skill. “Core” does not mean every role loads every skill. Use one review entry point to avoid repeating the same review.

| Skill | Use in this flow | Decision |
| --- | --- | --- |
| `gortex-guide` | Shared tool-routing and evidence protocol | Core |
| `gortex-explore` | Intake and targeted investigation | Core |
| `gortex-impact` | Plan risk assessment and changed-contract review | Core |
| `gortex-safe-edit` | Implementation source changes | Core |
| `gortex-add-test` | Behavior changes and regressions needing test work | Core when behavior changes |
| `gortex-pr-review` | Local changeset review, with explicit actual-worktree scope | Core review option |
| `gortex-pr-review-agent` | Alternative packaged reviewer role | Choose instead of the preceding review entry point when appropriate |
| `gortex-debug` | Reproduce and diagnose a defect | Conditional |
| `gortex-cross-repo-usage` | Shared APIs and verified consumers in other indexed repositories | Conditional |
| `gortex-dataflow-trace` | Data propagation, persistence, trust boundaries or concurrency questions | Conditional |
| `gortex-co-change` | Historical coupling as a lead for investigation | Conditional; never an automatic instruction to edit companion files |
| `gortex-incident-investigation` | Production incidents with operational evidence | Conditional |
| `gortex-episode-replay` | Reconstruct a historical regression/change episode | Conditional |
| `gortex-refactor` | Refactoring explicitly needed by the approved plan | Conditional; not a cleanup pass |
| `gortex-rename` | Approved semantic rename | Conditional |
| `gortex-extract-function` | Approved extraction supported by the active language tooling | Conditional |
| `gortex-fix-all` | An explicitly requested batch of fixes | Exclude from normal task flow |
| `gortex-onboarding` | First encounter with an unfamiliar repository | Setup or substantial knowledge gap |
| `gortex-quality-audit` | Dedicated repository quality assessment | Separate job |
| `gortex-architecture-review` | Explicit architectural work or a concrete architectural risk | Separate or narrowly triggered job |
| `gortex-cli` | A deliberately CLI-only agent harness | Alternative transport; not missing-MCP recovery |

Gortex also packages `gortex-search` and `gortex-impact` Claude subagents. Their graph-focused tool lists are useful examples of limited-role permissions. They are not a complete intake agent: Jira, SQL and cloud access remain separate concerns. Prefer Paseo-managed stage agents for a workflow intended to support both Claude and Codex.

Generated per-community skills (`gortex init --skills`) can provide useful module entry points. Treat them as generated navigation aids and recheck referenced code; do not require regenerating all of them for every task worktree.

Sources: [all bundled bodies](https://github.com/zzet/gortex/blob/v0.64.3/internal/agents/commands_bodies.go), [Claude subagents](https://github.com/zzet/gortex/blob/v0.64.3/internal/agents/claudecode/subagents.go), [skill documentation](https://github.com/zzet/gortex/blob/v0.64.3/docs/skills.md). Where older descriptive documentation and current skill bodies differ, this audit follows the tagged implementation.

## What to borrow from the other projects

### GitNexus: the best starting point for the handoff and human gate

Its published plugin now contains explicit `gitnexus-plan`, `gitnexus-work`, `gitnexus-review` and `gitnexus-lfg` skills. The LFG flow requires explicit approval after planning, and a headless execution stops at that point. Structural drift returns to planning. However, its work stage creates commits, so it needs adaptation for the requested stop-before-commit flow.

The most useful design is the context ledger and implementation context pack: acceptance criteria, verified source anchors, relevant relationships, existing patterns, intended edits, test scenarios, runnable commands, assumptions and an explicit list of things to avoid. Its provenance accounts for dirty and untracked source, rather than pinning only a Git HEAD. Adapt the concept, keeping small tasks small.

The review workflow supports targeted blast-radius investigation and requires concrete reachable failures for findings. Borrow that evidence standard. Do not duplicate the GitNexus index alongside Gortex merely to obtain these practices, or copy its optional large CI reviewer ensemble into every task.

Sources: [LFG](https://github.com/abhigyanpatwari/GitNexus/blob/68c42009df8ce4dd0f59042cbbfede9aa3784096/gitnexus-claude-plugin/skills/gitnexus-lfg/SKILL.md), [context pack](https://github.com/abhigyanpatwari/GitNexus/blob/68c42009df8ce4dd0f59042cbbfede9aa3784096/gitnexus-claude-plugin/skills/gitnexus-plan/references/context-pack.md), [review](https://github.com/abhigyanpatwari/GitNexus/blob/68c42009df8ce4dd0f59042cbbfede9aa3784096/gitnexus-claude-plugin/skills/gitnexus-review/SKILL.md).

### Compound Engineering: scope control, structured worker returns and useful learning

Borrow the scope-guardian lens: justify each new abstraction or structural change against the current requirement and existing project conventions. Keep deferred ideas out of implementation. Its planning and review practices connect requirements to implementation intent, and its return-to-caller work mode produces a useful structured result with completed units, verification evidence and blockers.

The complete `lfg` skill is intentionally autonomous and includes shipping. Even `ce-work` return-to-caller mode can retain checkpoint or incremental commits. Both need explicit adaptation. Use the report-only review style rather than an auto-fix-and-publish path.

Its learning step is useful only when there is a verified, non-obvious lesson worth retaining. For this flow, create a scoped candidate after review and promote it when validated; do not turn every completed task into new global instructions. Fold a simplicity check into the existing review instead of automatically running another broad simplification stage.

Sources: [LFG](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/lfg/SKILL.md), [scope guardian](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-doc-review/references/personas/scope-guardian-reviewer.md), [worker return](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-work/references/return-to-caller.md), [learning](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-compound/SKILL.md).

### Superpowers: independent judgment and evidence before completion

Borrow the requirement to verify actual code rather than trust the implementer's report. Its current task-reviewer design reads the diff once and gives two verdicts: specification compliance and code quality. This is more efficient than assuming two separate reviewer agents are required for every small task.

Use its root-cause-first debugging and behavior-focused regression testing. Require fresh-enough evidence tied to the source under review before declaring completion. Re-review the fix and outstanding findings instead of repeatedly generating unrelated nits in unchanged code.

Do not adopt frequent commits, another worktree creation layer, mandatory tiny-task agent turnover, or an automatic finishing/merge flow. Paseo should own the worktree. Use brainstorming only when the requirements need design work, and combine that with the existing human plan review rather than adding redundant approvals.

Sources: [task reviewer](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/subagent-driven-development/task-reviewer-prompt.md), [verification](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/verification-before-completion/SKILL.md), [debugging](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/systematic-debugging/SKILL.md), [plan writing](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/writing-plans/SKILL.md).

## Proposed LFG contract

The following is our proposed design, not a claim that any reviewed plugin already enforces it.

### Four worker roles and a controller

1. **Intake** produces the evidence brief. It can read relevant external systems and code but cannot modify project source or external resources.
2. **Planner** produces the implementation plan and context pack. It can perform focused follow-up research, but cannot implement.
3. **Implementer** changes source only after the recorded plan approval and performs the required build/tests. It returns a structured result and cannot authorize its own scope expansion.
4. **Reviewer** independently inspects the code, plan and evidence. It reports findings; the implementer handles accepted fixes.
5. **Controller** owns stage transitions, isolated workspace identity, durable artifacts, approval records, source snapshots, retries, limits and final presentation.

A fifth permanently separate test-writing agent is not necessary for an initial version. Add specialized database, security or UI review only when the task's actual risk warrants it.

### Minimum durable artifacts

| Artifact | Required information |
| --- | --- |
| Evidence brief | Requirements and sources; observations versus assumptions; relevant ticket decisions; verified code and external-state facts; unresolved questions |
| Approved plan | Acceptance criteria; minimal intended changes; existing patterns to preserve; explicit non-goals; tests and validation commands; risks and allowed scope |
| Implementation context | Relevant files/symbols and source provenance; execution path; constraints; test scenarios; avoid list; source baseline |
| Worker result | `complete`, `blocked` or `failed`; plan revision; changed files; acceptance criteria addressed; checks performed; deviations and blockers |
| Review result | Separate specification and quality verdicts; source snapshot; actionable findings; supporting evidence; resolution of prior findings |
| Run state | Stage; host/workspace/agent identities; attempts; artifact versions; user approvals; last verified source snapshot |

For source provenance, account for base commit plus index/worktree/untracked content, renames and deletions. Do not invalidate a plan because its progress artifact changed; do invalidate relevant code assumptions when their underlying source changes. The approved plan should stay immutable during implementation; progress and proposed amendments belong in separate records.

### Scope rules that prevent overengineering

- Every source change must support an acceptance criterion, an approved implementation step, or a necessary scoped test. A useful unrelated improvement goes into a follow-up note.
- Prefer an existing project pattern when it meets the requirement. New dependencies, shared frameworks, generalized extension points or public contracts require an explicit reason in the plan.
- No speculative extensibility, opportunistic file reorganization, broad formatting or repo-wide fixes.
- Expected files are a review aid, not an inflexible trap. An adjacent test/helper needed for the approved behavior can be disclosed within policy; a new behavior, subsystem, dependency or architectural decision returns for a plan amendment.
- Scope deviations that materially change behavior or risk invalidate the previous approval. An agent cannot relabel a scope expansion as cleanup to bypass the gate.
- Review may identify an error in an approved plan. Approval does not require implementing a demonstrably incorrect design.

### Validation and review rules

- For changed behavior, reproduce the defect or establish the missing behavior before the fix when feasible, then show it passes. Reuse or strengthen existing tests before adding redundant ones.
- For documentation or mechanical non-behavioral work, use proportionate checks and explain the exception instead of manufacturing tests.
- Select DB/integration/UI tests because of a concrete risk. Read-only intake is separate from later approved migrations or cloud changes; use disposable or nonproduction validation environments for mutating checks.
- A missing test environment is an explicit limitation, not a passing check.
- Review both omissions and unnecessary additions, along with correctness and maintainability. Risk scores and speculative hypotheticals do not constitute findings by themselves.
- Apply accepted in-scope repairs, rerun checks affected by those repairs, and perform a scoped re-review. Two unsuccessful rounds is a proposed initial limit; then request a concrete human decision.
- Never automatically call `risk_ack`, permanently suppress a finding, or downgrade a blocker solely to complete the workflow.
- The final human approval names the code snapshot. Any subsequent source change requires appropriate revalidation and renewed review.
- Remain ready for commit. Commit, push, PR creation, Jira comments and posted code-review comments are separate actions.

### Recovery and reliability

Persist the stage and artifacts on the daemon side so a mobile client disconnect or agent restart does not lose the workflow. On resume, reconcile existing agents and worktrees before creating new ones. Use idempotency keys for stage starts and do not blindly retry source mutations. Keep an append-only event history for transitions and approval decisions; do not allow arbitrary worker text to advance the state machine.

A skill can improve compliance, but cannot guarantee it. Actual confidence comes from enforceable tool permissions, stage-specific inputs, observable checks, independent review and approval records. Whether a proposed provider/harness supports the required restrictions must be checked during implementation.

## Appendix A: all compact domains and their placement

| Domain | Operations / selectors | Placement |
| --- | --- | --- |
| `analyze` | `agent_config`, `architecture`, `churn`, `citation`, `clones`, `co_change`, `communities`, `contracts`, `coupling`, `extraction`, `health`, `help`, `inspection_catalog`, `inspections`, `knowledge_gaps`, `lint`, `processes`, `recent_changes`, `replay`, `surprising_connections`, `untested`, `why`; additional kinds in Appendix C | **Conditional read.** Answer a specific risk or architecture question; avoid automatic whole-repository audits. |
| `ask` | `research` | **Optional read/research.** Configured LLM research is not needed by default when a Paseo investigator already owns the task. |
| `capabilities` | Discovery and per-operation schema requests | **Core discovery.** Resolve available operations and their real schemas at setup or when needed. |
| `change` | `api_impact`, `code_actions`, `compare_branches`, `compare_overlay`, `contract`, `detect`, `diagnostics`, `edit_plan`, `guards`, `impact`, `overlay_branches`, `overlay_state`, `pattern`, `preview`, `ranges`, `receipt`, `simulate`, `tests`, `verify` | **Core read/preflight.** Assess impact, preview changes, select tests and examine actual mutation outcomes. |
| `edit` | `apply_overlay`, `batch`, `docs`, `export_graph`, `file`, `scaffold`, `skill`, `symbol`, `wiki`, `write` | **Implementer writes.** Approved source edits only; generated docs, scaffolds and exports must have a task reason. |
| `explore` | `closure`, `context`, `localize`, `outline`, `plan`, `prefetch`, `suggest`, `task`, `wakeup` | **Core read.** Task-oriented discovery; plan routes tool use rather than authoring the implementation plan. |
| `overlay` | `delete`, `drop`, `drop_branch`, `fork`, `keepalive`, `merge`, `push`, `register`, `simulate`, `switch` | **Optional session state.** Speculative layers add complexity; use the ordinary Paseo worktree for version one. |
| `pr` | `conflicts`, `impact`, `list`, `reviewers`, `risk`, `triage` | **Conditional read.** Relevant existing PR context; not a prerequisite for an uncommitted local task. |
| `publish_review` | `post` | **Exclude from this flow.** Posts external review comments; outside the requested stop-before-commit workflow. |
| `read` | `artifact`, `editing_context`, `file`, `history`, `source`, `summary`, `symbols` | **Core read.** Inspect source and artifacts supporting decisions; use exact checkout state. |
| `recall` | `distill`, `memories`, `notebook_find`, `notebook_list`, `notebook_show`, `notes`, `onboarding`, `surface` | **Conditional read.** Retrieve applicable prior lessons and onboarding context; verify relevance and freshness. |
| `refactor` | `apply_code_action`, `delete`, `fix_all`, `inline`, `move`, `rename` | **Explicitly planned writes.** Only a required approved rename, move, extraction or similar structural change. |
| `relations` | `callers`, `cluster`, `declaration`, `dependencies`, `dependents`, `hierarchy`, `implementations`, `import_path`, `overrides`, `references`, `usages` | **Core targeted read.** Inspect relevant callers, consumers and contracts rather than traversing the whole graph. |
| `remember` | `edit_memory`, `memory`, `note`, `notebook`, `notebook_used`, `rename_memory`, `risk_ack`, `suppress_finding` | **Controlled durable writes.** Optional verified learning. Do not auto-acknowledge risks or suppress findings. |
| `response` | `export_context`, `grep`, `peek`, `slice`, `stats` | **Conditional read/export.** Reuse and package already retrieved evidence without repeated broad queries. |
| `review` | `critique`, `diff_context`, `pack`, `pr_context`, `questions`, `run`, `sibling_context` | **Core read/review.** Actual-worktree graph review plus independent reasoning; optional LLM assistance is not required. |
| `search` | `artifacts`, `ast`, `completion`, `files`, `symbols`, `text`, `winnow` | **Core read.** Resolve known symbols, source text and artifacts; do not treat no results as proof of absence. |
| `session` | `agents`, `cursor`, `planning_mode`, `proxy_disable`, `proxy_enable`, `subscribe`, `unsubscribe`, `workflow` | **Optional controller/session aid.** Planning/workflow coordination is not durable human approval or a permission boundary. |
| `trace` | `call_chain`, `cfg`, `flow`, `graph`, `path`, `taint`, `walk` | **Conditional read.** Trace the specific execution or data path implicated by the task. |
| `workspace` | `active_project`, `checkouts`, `graph`, `index`, `info`, `project`, `proxy`, `repos`, `scopes` | **Core preflight/read.** Check repository identity, checkout selection and index health. |
| `workspace_admin` | `blame`, `coverage`, `delete_scope`, `enrich_churn`, `enrich_releases`, `feedback`, `index`, `reindex`, `save_scope`, `set_active_project`, `sql_rebuild`, `temporal_verify`, `track`, `untrack` | **Controller maintenance.** Index/tracking/enrichment changes are not routine worker steps. |

This table follows the compact public surface. The registry keeps channel-specific subscription handlers internally, while public session discovery exposes `subscribe` and `unsubscribe`. `change` keeps nonmutating variants of operations whose mutating variants live under `overlay`, `remember` or `workspace_admin`; discover schemas rather than forwarding arbitrary legacy flags.

Sources: [registry](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/facade_registry.go), [public capability generation](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/facade_tools.go).

## Appendix B: complete static implementation/compatibility name inventory

The inspected source contains 183 unique literal `mcp.NewTool` names. The migration registry additionally references `tools_search`, producing 184 distinct implementation/compatibility names in this union. These are not 184 tools exposed simultaneously by the compact profile, which has 21 public names. The registry contains 188 explicit operation records, including five hidden compatibility mappings; some handlers have deliberate multiple effect mappings, and analysis kinds are also added dynamically.

“Compatibility” entries are not public operation names to put into new prompts. Four checkout-management handlers have no compact mapping in the inspected release. Per-handler source links identify where the registration was inspected; registry-only entries link to the registry.

| Implementation / compatibility name | Compact mapping | Recommended use |
| --- | --- | --- |
| [`agent_registry`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/agent_registry.go) | `session(agents)` | Optional controller/session aid |
| [`analyze`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enhancements.go) | `analyze(help)`; `workspace_admin(blame)`; `workspace_admin(coverage)`; `workspace_admin(sql_rebuild)`; `workspace_admin(temporal_verify)` | Conditional read / Controller maintenance |
| [`api_impact`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enhancements.go) | `change(api_impact)` | Core read/preflight |
| [`apply_code_action`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_lsp.go) | `refactor(apply_code_action)` | Explicitly planned writes |
| [`ask`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_llm.go) | `ask(research)` | Optional read/research |
| [`audit_agent_config`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enhancements.go) | `analyze(agent_config)` | Conditional read |
| [`audit_health`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_audit.go) | `analyze(health)` | Conditional read |
| [`batch_edit`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enhancements.go) | `edit(batch)` | Implementer writes |
| [`batch_symbols`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `read(symbols)` | Core read |
| [`change_contract`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_symbols_for_ranges.go) | `change(contract)`; `remember(risk_ack)` | Core read/preflight / Controlled durable writes |
| [`check_guards`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enhancements.go) | `change(guards)` | Core read/preflight |
| [`check_onboarding_performed`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_memories.go) | `recall(onboarding)` | Conditional read |
| [`check_references`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_check_references.go) | `relations(references)` | Core targeted read |
| [`compare_branches`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_overlay_branch.go) | `change(compare_branches)` | Core read/preflight |
| [`compare_with_overlay`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_overlay_diff.go) | `change(compare_overlay)` | Core read/preflight |
| [`conflicts_prs`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_conflicts.go) | `pr(conflicts)` | Conditional read |
| [`context_closure`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_closure.go) | `explore(closure)` | Core read |
| [`contracts`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enhancements.go) | `analyze(contracts)` | Conditional read |
| [`critique_review`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_critique_review.go) | `review(critique)` | Core read/review |
| [`ctx_grep`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_postfilter.go) | `response(grep)` | Conditional read/export |
| [`ctx_peek`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_postfilter.go) | `response(peek)` | Conditional read/export |
| [`ctx_slice`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_postfilter.go) | `response(slice)` | Conditional read/export |
| [`ctx_stats`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_postfilter.go) | `response(stats)` | Conditional read/export |
| [`delete_scope`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_scopes.go) | `workspace_admin(delete_scope)` | Controller maintenance |
| [`detect_changes`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_analysis.go) | `change(detect)` | Core diff analysis; separately inventory new/untracked files. |
| [`diff_context`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enhancements.go) | `review(diff_context)` | Core read/review |
| [`distill_session`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_notes.go) | `recall(distill)` | Conditional read |
| [`edit_file`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `edit(file)` | Implementer writes |
| [`edit_memory`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_memories.go) | `remember(edit_memory)` | Controlled durable writes |
| [`edit_symbol`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `edit(symbol)` | Implementer writes |
| [`enrich_churn`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enrich_churn.go) | `workspace_admin(enrich_churn)` | Controller maintenance |
| [`enrich_releases`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enrich_releases.go) | `workspace_admin(enrich_releases)` | Controller maintenance |
| [`explain_change_impact`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `change(impact)` | Core read/preflight |
| [`explain_view`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_checkouts.go) | No compact mapping in the inspected registry | Controller checkout diagnostic; CLI or compatible legacy surface. |
| [`explore`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_explore.go) | `explore(localize)`; `explore(task)` | Core read |
| [`export_context`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enhancements.go) | `response(export_context)` | Conditional read/export |
| [`export_graph`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_export.go) | `edit(export_graph)` | Implementer writes |
| [`feedback`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enhancements.go) | `workspace_admin(feedback)` | Controller maintenance |
| [`find_clones`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_clones.go) | `analyze(clones)` | Conditional read |
| [`find_co_changing_symbols`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_cochange.go) | `analyze(co_change)` | Conditional read |
| [`find_declaration`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_find_declaration.go) | `relations(declaration)` | Core targeted read |
| [`find_files`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_find_files.go) | `search(files)` | Core read |
| [`find_implementations`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | `relations(implementations)` | Core targeted read |
| [`find_import_path`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `relations(import_path)` | Core targeted read |
| [`find_overrides`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | `relations(overrides)` | Core targeted read |
| [`find_usages`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | `relations(usages)` | Core targeted read |
| [`fix_all_in_file`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_lsp.go) | `refactor(fix_all)` | Explicitly planned writes |
| [`flow_between`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_dataflow.go) | `trace(flow)` | Conditional read |
| [`forget_checkout`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_checkouts.go) | No compact mapping in the inspected registry | Controller maintenance only. |
| [`generate_docs`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_wiki.go) | `edit(docs)` | Implementer writes |
| [`generate_skill`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_generate_skill.go) | `edit(skill)` | Implementer writes |
| [`generate_wiki`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_wiki.go) | `edit(wiki)` | Implementer writes |
| [`get_active_project`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_multi.go) | `workspace(active_project)` | Core preflight/read |
| [`get_architecture`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_architecture.go) | `analyze(architecture)` | Conditional read |
| [`get_artifact`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_artifacts.go) | `read(artifact)` | Core read |
| [`get_call_chain`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | `trace(call_chain)` | Conditional read |
| [`get_callers`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | `relations(callers)` | Core targeted read |
| [`get_cfg`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_cfg.go) | `trace(cfg)` | Conditional read |
| [`get_churn_rate`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_churn.go) | `analyze(churn)` | Conditional read |
| [`get_class_hierarchy`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | `relations(hierarchy)` | Core targeted read |
| [`get_cluster`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | `relations(cluster)` | Core targeted read |
| [`get_code_actions`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_lsp.go) | `change(code_actions)` | Core read/preflight |
| [`get_communities`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_analysis.go) | `analyze(communities)` | Conditional read |
| [`get_coupling_metrics`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coupling.go) | `analyze(coupling)` | Conditional read |
| [`get_dependencies`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | `relations(dependencies)` | Core targeted read |
| [`get_dependents`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | `relations(dependents)` | Core targeted read |
| [`get_diagnostics`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_lsp.go) | `change(diagnostics)` | Core read/preflight |
| [`get_edit_plan`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `change(edit_plan)` | Core read/preflight |
| [`get_editing_context`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `read(editing_context)` | Core read |
| [`get_extraction_candidates`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_extract_candidates.go) | `analyze(extraction)` | Conditional read |
| [`get_file_summary`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | `read(summary)` | Core read |
| [`get_knowledge_gaps`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_knowledge_gaps.go) | `analyze(knowledge_gaps)` | Conditional read |
| [`get_pr_impact`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_prs.go) | `pr(impact)` | Conditional read |
| [`get_processes`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_analysis.go) | `analyze(processes)` | Conditional read |
| [`get_recent_changes`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `analyze(recent_changes)` | Conditional read |
| [`get_repo_outline`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | `explore(outline)` | Core read |
| [`get_surprising_connections`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_surprising.go) | `analyze(surprising_connections)` | Conditional read |
| [`get_symbol`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | compatibility: `read.symbol_metadata_compat` | Core read |
| [`get_symbol_history`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enhancements.go) | `read(history)` | Core read |
| [`get_symbol_source`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `read(source)` | Core read |
| [`get_test_targets`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `change(tests)` | Select likely tests; run actual project verification separately. |
| [`get_untested_symbols`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `analyze(untested)` | Conditional read |
| [`gortex_wakeup`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_wakeup.go) | `explore(wakeup)` | Core read |
| [`graph_completion_search`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_graph_completion.go) | `search(completion)` | Core read |
| [`graph_query`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_graph_query.go) | `trace(graph)` | Conditional read |
| [`graph_stats`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | `workspace(graph)` | Core preflight/read |
| [`grep_results`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_postfilter.go) | compatibility: `response.grep_compat` | Conditional read/export |
| [`head_results`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_postfilter.go) | compatibility: `response.head_compat` | Conditional read/export |
| [`index_health`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enhancements.go) | `workspace(index)` | Core preflight/read |
| [`index_repository`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | `workspace_admin(index)` | Controller maintenance |
| [`inline_symbol`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_move_inline.go) | `refactor(inline)` | Explicitly planned writes |
| [`lint_file`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_lint.go) | `analyze(lint)` | Conditional read |
| [`list_checkouts`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_checkouts.go) | `workspace(checkouts)` | Core preflight/read |
| [`list_inspections`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_inspections.go) | `analyze(inspection_catalog)` | Conditional read |
| [`list_prs`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_prs.go) | `pr(list)` | Conditional read |
| [`list_repos`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_workspace.go) | `workspace(repos)` | Core preflight/read |
| [`list_scopes`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_scopes.go) | `workspace(scopes)` | Core preflight/read |
| [`move_symbol`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_move_inline.go) | `refactor(move)` | Explicitly planned writes |
| [`mutation_status`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `change(receipt)` | Core read/preflight |
| [`nav`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_nav.go) | `session(cursor)` | Optional controller/session aid |
| [`notebook_find`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_notebook.go) | `recall(notebook_find)` | Conditional read |
| [`notebook_list`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_notebook.go) | `recall(notebook_list)` | Conditional read |
| [`notebook_save`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_notebook.go) | `remember(notebook)` | Controlled durable writes |
| [`notebook_show`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_notebook.go) | `recall(notebook_show)` | Conditional read |
| [`notebook_used`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_notebook.go) | `remember(notebook_used)` | Controlled durable writes |
| [`overlay_branches`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_overlay_branch.go) | `change(overlay_branches)` | Core read/preflight |
| [`overlay_delete`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_overlay.go) | `overlay(delete)` | Optional session state |
| [`overlay_drop`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_overlay.go) | `overlay(drop)` | Optional session state |
| [`overlay_drop_branch`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_overlay_branch.go) | `overlay(drop_branch)` | Optional session state |
| [`overlay_fork`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_overlay_branch.go) | `overlay(fork)` | Optional session state |
| [`overlay_keepalive`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_overlay.go) | `overlay(keepalive)` | Optional session state |
| [`overlay_list`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_overlay.go) | `change(overlay_state)` | Core read/preflight |
| [`overlay_merge`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_overlay_branch.go) | `edit(apply_overlay)`; `overlay(merge)` | Implementer writes / Optional session state |
| [`overlay_push`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_overlay.go) | `overlay(push)` | Optional session state |
| [`overlay_register`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_overlay.go) | `overlay(register)` | Optional session state |
| [`overlay_switch`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_overlay_branch.go) | `overlay(switch)` | Optional session state |
| [`plan_turn`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `explore(plan)` | Next-call router, not an implementation plan. |
| [`post_review`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_review.go) | `publish_review(post)` | External publication; excluded from this flow. |
| [`pr_review_context`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_pr_review_context.go) | `review(pr_context)` | Core read/review |
| [`pr_risk`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_pr_risk.go) | `pr(risk)` | Conditional read |
| [`prefetch_context`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enhancements.go) | `explore(prefetch)` | Core read |
| [`preview_edit`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_simulate.go) | `change(preview)` | Core read/preflight |
| [`proxy_disable`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_proxy.go) | `session(proxy_disable)` | Optional controller/session aid |
| [`proxy_enable`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_proxy.go) | `session(proxy_enable)` | Optional controller/session aid |
| [`proxy_status`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_proxy.go) | `workspace(proxy)` | Core preflight/read |
| [`query_memories`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_memories.go) | `recall(memories)` | Conditional read |
| [`query_notes`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_notes.go) | `recall(notes)` | Conditional read |
| [`query_project`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_multi.go) | `workspace(project)` | Core preflight/read |
| [`read_file`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `read(file)` | Core read |
| [`reconcile_checkouts`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_checkouts.go) | No compact mapping in the inspected registry | Controller recovery only when checkout state needs it. |
| [`reindex_repository`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | `workspace_admin(reindex)` | Controller maintenance |
| [`rename_memory`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_memories.go) | `remember(rename_memory)` | Controlled durable writes |
| [`rename_symbol`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `refactor(rename)` | Explicitly planned writes |
| [`replay_episode`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_replay_episode.go) | `analyze(replay)` | Conditional read |
| [`review`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_review.go) | `review(run)` | Core read/review |
| [`review_pack`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_review.go) | `review(pack)` | Core worktree review; pasted diffs skip symbol-dependent gates. |
| [`run_inspections`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_inspections.go) | `analyze(inspections)` | Conditional read |
| [`safe_delete_symbol`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_safe_delete.go) | `refactor(delete)` | Explicitly planned writes |
| [`save_note`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_notes.go) | `remember(note)` | Controlled durable writes |
| [`save_scope`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_scopes.go) | `workspace_admin(save_scope)` | Controller maintenance |
| [`scaffold`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enhancements.go) | `edit(scaffold)` | Implementer writes |
| [`search_artifacts`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_artifacts.go) | `search(artifacts)` | Core read |
| [`search_ast`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_ast.go) | `search(ast)` | Core read |
| [`search_symbols`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_core.go) | `search(symbols)` | Core read |
| [`search_text`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_analysis.go) | `search(text)` | Core read |
| [`set_active_project`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_multi.go) | `workspace_admin(set_active_project)` | Controller maintenance |
| [`set_planning_mode`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_mode.go) | `session(planning_mode)` | Optional controller/session aid |
| [`set_primary_checkout`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_checkouts.go) | No compact mapping in the inspected registry | Controller maintenance; never routine task work. |
| [`sibling_diff_context`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_review.go) | `review(sibling_context)` | Core read/review |
| [`simulate_chain`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_simulate.go) | `change(simulate)`; `overlay(simulate)` | Core read/preflight / Optional session state |
| [`smart_context`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `explore(context)` | Core read |
| [`store_memory`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_memories.go) | `remember(memory)` | Controlled durable writes |
| [`subscribe_daemon_health`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/health.go) | `session(subscribe)` channel handler | Optional controller/session aid |
| [`subscribe_diagnostics`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/diagnostics.go) | `session(subscribe)` channel handler | Optional controller/session aid |
| [`subscribe_graph_invalidated`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/graph_invalidated.go) | `session(subscribe)` channel handler | Optional controller/session aid |
| [`subscribe_stale_refs`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/stale_refs.go) | `session(subscribe)` channel handler | Optional controller/session aid |
| [`subscribe_workspace_readiness`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/readiness.go) | `session(subscribe)` channel handler | Optional controller/session aid |
| [`suggest_pattern`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `change(pattern)` | Core read/preflight |
| [`suggest_queries`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_analysis.go) | `explore(suggest)` | Core read |
| [`suggest_reviewers`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_suggest_reviewers.go) | `pr(reviewers)` | Conditional read |
| [`suggested_review_questions`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_review_questions.go) | `review(questions)` | Core read/review |
| [`suppress_finding`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_review.go) | `remember(suppress_finding)` | No automatic permanent suppression. |
| [`surface_memories`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_memories.go) | `recall(surface)` | Conditional read |
| [`symbols_for_ranges`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_symbols_for_ranges.go) | `change(ranges)` | Core read/preflight |
| [`taint_paths`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_dataflow.go) | `trace(taint)` | Conditional read |
| [`tool_profile`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tool_profile.go) | compatibility: `capabilities.legacy_profile` | Core discovery |
| [`tools_search`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/facade_registry.go) | compatibility: `capabilities.legacy_search` | Core discovery |
| [`trace_path`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_dataflow.go) | `trace(path)` | Conditional read |
| [`track_repository`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_multi.go) | `workspace_admin(track)` | Controller maintenance |
| [`triage_prs`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_prs.go) | `pr(triage)` | Conditional read |
| [`unsubscribe_daemon_health`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/health.go) | `session(unsubscribe)` channel handler | Optional controller/session aid |
| [`unsubscribe_diagnostics`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/diagnostics.go) | `session(unsubscribe)` channel handler | Optional controller/session aid |
| [`unsubscribe_graph_invalidated`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/graph_invalidated.go) | `session(unsubscribe)` channel handler | Optional controller/session aid |
| [`unsubscribe_stale_refs`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/stale_refs.go) | `session(unsubscribe)` channel handler | Optional controller/session aid |
| [`unsubscribe_workspace_readiness`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/readiness.go) | `session(unsubscribe)` channel handler | Optional controller/session aid |
| [`untrack_repository`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_multi.go) | `workspace_admin(untrack)` | Controller maintenance |
| [`verify_change`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enhancements.go) | `change(verify)` | Core read/preflight |
| [`verify_citation`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_citation.go) | `analyze(citation)` | Committed-source citation checking; not proof of dirty-file freshness. |
| [`walk_graph`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_walk.go) | `trace(walk)` | Conditional read |
| [`why`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_why.go) | `analyze(why)` | Conditional read |
| [`winnow_symbols`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_enhancements.go) | `search(winnow)` | Core read |
| [`workflow`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_workflow.go) | `session(workflow)` | Optional controller/session aid |
| [`workspace_info`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_workspace.go) | `workspace(info)` | Core preflight/read |
| [`write_file`](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_coding.go) | `edit(write)` | Implementer writes |

## Appendix C: complete unified analysis-kind inventory

These are the names in `AnalyzeKinds()` in the inspected release. Four mutating kinds belong under `workspace_admin` in the compact API. Additional convenience analysis operations in Appendix A are defined separately in the facade registry. Names can be aliases, and language/enrichment support is not uniform.

All are conditional. Choose them because a concrete task question requires the evidence, not because they exist. Review reported scope/freshness limitations; an operation accepting a scope selector does not guarantee every underlying analysis narrows identically.

| Purpose | Kinds |
| --- | --- |
| Database / integration / configuration | `annotation_users`, `config_readers`, `dbt_models`, `env_var_users`, `event_emitters`, `external_calls`, `images`, `k8s_resources`, `kustomize`, `models`, `orphan_tables`, `pubsub`, `route_frameworks`, `routes`, `sql_call_sites`, `string_emitters`, `unreferenced_tables` |
| Correctness / debugging / security | `channel_ops`, `constructors_missing_fields`, `def_use`, `error_surface`, `field_writers`, `goroutine_spawns`, `hygiene`, `indirect_mutations`, `named`, `race_writes`, `review`, `sast`, `temporal_orphans`, `unclosed_channels`, `unsafe_patterns` |
| Tests / impact / contract risk | `coverage_gaps`, `coverage_summary`, `cross_repo`, `impact`, `tests_as_edges`, `would_create_cycle` |
| Index evidence / resolution diagnostics | `connectivity_health`, `doc_staleness`, `edge_audit`, `ref_facts`, `resolution_outcomes`, `retrieval_log`, `speculative`, `synthesizers` |
| Language / framework-specific | `cgo_users`, `drupal_hooks`, `swiftui_views`, `uikit_classes`, `wasm_users` |
| Architecture / history / quality, only with task relevance | `bottlenecks`, `clusters`, `components`, `concepts`, `cycles`, `dead_code`, `domain`, `fixes_history`, `health_score`, `hotspots`, `kcore`, `log_events`, `louvain`, `ownership`, `pagerank`, `releases`, `role`, `scc`, `stale_code`, `stale_flags`, `suggest_boundaries`, `todos`, `wcc` |
| Controller maintenance, not read-only `analyze` | `blame`, `coverage`, `sql_rebuild`, `temporal_verify` |

Catalog coverage: 77 analysis-kind names. Source: [canonical analysis catalog](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/analyze_kinds.go).

## Appendix D: other skill catalogs examined

The recommendation adapts concepts; it does not install or invoke these complete skill suites. A skill's name in this catalog does not mean it is appropriate for every LFG task.

### Compound Engineering — 35 skill files

[ce-babysit-pr](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-babysit-pr/SKILL.md), [ce-bakeoff](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-bakeoff/SKILL.md), [ce-brainstorm](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-brainstorm/SKILL.md), [ce-code-review](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-code-review/SKILL.md), [ce-commit](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-commit/SKILL.md), [ce-commit-push-pr](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-commit-push-pr/SKILL.md), [ce-compound](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-compound/SKILL.md), [ce-compound-refresh](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-compound-refresh/SKILL.md), [ce-debug](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-debug/SKILL.md), [ce-doc-review](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-doc-review/SKILL.md), [ce-dogfood](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-dogfood/SKILL.md), [ce-explain](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-explain/SKILL.md), [ce-handoff](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-handoff/SKILL.md), [ce-ideate](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-ideate/SKILL.md), [ce-noslop](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-noslop/SKILL.md), [ce-optimize](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-optimize/SKILL.md), [ce-plan](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-plan/SKILL.md), [ce-polish](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-polish/SKILL.md), [ce-pov](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-pov/SKILL.md), [ce-product-pulse](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-product-pulse/SKILL.md), [ce-promote](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-promote/SKILL.md), [ce-proof](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-proof/SKILL.md), [ce-prototype](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-prototype/SKILL.md), [ce-resolve-pr-feedback](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-resolve-pr-feedback/SKILL.md), [ce-retune](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-retune/SKILL.md), [ce-riffrec-feedback-analysis](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-riffrec-feedback-analysis/SKILL.md), [ce-setup](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-setup/SKILL.md), [ce-simplify-code](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-simplify-code/SKILL.md), [ce-strategy](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-strategy/SKILL.md), [ce-sweep](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-sweep/SKILL.md), [ce-test-browser](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-test-browser/SKILL.md), [ce-test-xcode](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-test-xcode/SKILL.md), [ce-work](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-work/SKILL.md), [ce-worktree](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/ce-worktree/SKILL.md), [lfg](https://github.com/EveryInc/compound-engineering-plugin/blob/f050478dfc2b9621a2a75fbe58b37f2468d3af4a/skills/lfg/SKILL.md).

### Superpowers — 14 skill files

[brainstorming](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/brainstorming/SKILL.md), [dispatching-parallel-agents](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/dispatching-parallel-agents/SKILL.md), [executing-plans](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/executing-plans/SKILL.md), [finishing-a-development-branch](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/finishing-a-development-branch/SKILL.md), [receiving-code-review](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/receiving-code-review/SKILL.md), [requesting-code-review](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/requesting-code-review/SKILL.md), [subagent-driven-development](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/subagent-driven-development/SKILL.md), [systematic-debugging](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/systematic-debugging/SKILL.md), [test-driven-development](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/test-driven-development/SKILL.md), [using-git-worktrees](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/using-git-worktrees/SKILL.md), [using-superpowers](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/using-superpowers/SKILL.md), [verification-before-completion](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/verification-before-completion/SKILL.md), [writing-plans](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/writing-plans/SKILL.md), [writing-skills](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/writing-skills/SKILL.md).

### GitNexus — 12 skill files

[gitnexus-cli](https://github.com/abhigyanpatwari/GitNexus/blob/68c42009df8ce4dd0f59042cbbfede9aa3784096/gitnexus-claude-plugin/skills/gitnexus-cli/SKILL.md), [gitnexus-debugging](https://github.com/abhigyanpatwari/GitNexus/blob/68c42009df8ce4dd0f59042cbbfede9aa3784096/gitnexus-claude-plugin/skills/gitnexus-debugging/SKILL.md), [gitnexus-exploring](https://github.com/abhigyanpatwari/GitNexus/blob/68c42009df8ce4dd0f59042cbbfede9aa3784096/gitnexus-claude-plugin/skills/gitnexus-exploring/SKILL.md), [gitnexus-guide](https://github.com/abhigyanpatwari/GitNexus/blob/68c42009df8ce4dd0f59042cbbfede9aa3784096/gitnexus-claude-plugin/skills/gitnexus-guide/SKILL.md), [gitnexus-impact-analysis](https://github.com/abhigyanpatwari/GitNexus/blob/68c42009df8ce4dd0f59042cbbfede9aa3784096/gitnexus-claude-plugin/skills/gitnexus-impact-analysis/SKILL.md), [gitnexus-lfg](https://github.com/abhigyanpatwari/GitNexus/blob/68c42009df8ce4dd0f59042cbbfede9aa3784096/gitnexus-claude-plugin/skills/gitnexus-lfg/SKILL.md), [gitnexus-pdg-query](https://github.com/abhigyanpatwari/GitNexus/blob/68c42009df8ce4dd0f59042cbbfede9aa3784096/gitnexus-claude-plugin/skills/gitnexus-pdg-query/SKILL.md), [gitnexus-plan](https://github.com/abhigyanpatwari/GitNexus/blob/68c42009df8ce4dd0f59042cbbfede9aa3784096/gitnexus-claude-plugin/skills/gitnexus-plan/SKILL.md), [gitnexus-refactoring](https://github.com/abhigyanpatwari/GitNexus/blob/68c42009df8ce4dd0f59042cbbfede9aa3784096/gitnexus-claude-plugin/skills/gitnexus-refactoring/SKILL.md), [gitnexus-review](https://github.com/abhigyanpatwari/GitNexus/blob/68c42009df8ce4dd0f59042cbbfede9aa3784096/gitnexus-claude-plugin/skills/gitnexus-review/SKILL.md), [gitnexus-taint-analysis](https://github.com/abhigyanpatwari/GitNexus/blob/68c42009df8ce4dd0f59042cbbfede9aa3784096/gitnexus-claude-plugin/skills/gitnexus-taint-analysis/SKILL.md), [gitnexus-work](https://github.com/abhigyanpatwari/GitNexus/blob/68c42009df8ce4dd0f59042cbbfede9aa3784096/gitnexus-claude-plugin/skills/gitnexus-work/SKILL.md).


The separate repository-local GitNexus PR-swarm review skill was also examined. It is not counted among the 12 published plugin skills above. Its larger ensemble is not a default recommendation for this flow.

### Translating GitNexus ideas to Gortex

| GitNexus concept | Gortex equivalent or related capability | Caveat |
| --- | --- | --- |
| Task query | `explore(task)` and targeted `search` | Preserve the question and evidence, not the original tool syntax. |
| Symbol context | `read(symbols, editing_context)` plus `relations` | Read actual implementation for decisive claims. |
| Blast radius | `change(impact, api_impact)` plus callers/dependents | Counts and risk scores are not defects. |
| Execution trace | `trace(call_chain, path)` | Verify resolution and relevant language support. |
| Changed-code detection | `change(detect)` | Add a separate complete new-file inventory. |
| Statement PDG analysis | Related `trace(cfg, flow, taint)` capabilities | Not a verified one-to-one substitute for GitNexus PDG/control-dependence/reaching-definition semantics. |
| Ad hoc graph query | `trace(graph)` | Gortex's query DSL is not assumed to be Cypher-compatible. |
| Context ledger and approval | LFG artifacts and Paseo controller | Application workflow, not a graph-tool feature. |

## What to build first

Start with four role skills and one shared scope/evidence contract, using the selected Gortex skills as references. Build the smallest controller that creates the Paseo worktree and agents, stores their outputs, enforces the two approval gates, and handles restart/retry correctly. Present the approved plan, evidence, current stage and complete diff in Paseo.

Agent Monitor or another dashboard may be useful presentation infrastructure, but its ability to enforce this state machine has not been verified in this audit. Treat it as a possible UI integration rather than assuming it already supplies the workflow engine. Avoid account-switching, simultaneous cross-host scheduling and a second code graph in version one.

Before declaring the implementation reliable, exercise meaningful workflow scenarios: an ordinary task; a material unanswered requirement; stale plan evidence; an unauthorized scope expansion; an untracked new source file; a failed or unavailable test; a reviewer rejection; and a daemon/client restart during a gate. These are implementation acceptance scenarios, not tests executed during this source review.
