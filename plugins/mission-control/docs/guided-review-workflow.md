# Guided decisions and code-review context

This client UX batch adds a guided Needs you queue, a review brief, and file controls that remain visible while the diff scrolls.

## Decisions

From Orchestrator → Needs you, Start decisions opens the first matching task. Next decision moves between that task's requests; Next task needing you moves through tasks within the current host, coordinator, search, and stage filters. Moving never sends a reply or approves anything. Delivery remains a separate step using the existing guarded delivery UI.

The selected request is remembered per host and task across task tabs. Refreshes that remove that request show a completion/availability message instead of automatically placing a different approval under the pointer. Permission requests, questions, plan approvals, and code review decisions have explicit guidance. A recorded question whose worker cannot be matched remains visible with an inspection link and no new reply control.

## Review

The collapsible review brief uses the current task/run/workspace/host's most recent recorded review request. It displays acceptance criteria, the author-supplied change summary and review result, visible unresolved finding counts, task problems, and up to five suggested files. File suggestions prioritize unresolved findings, then the existing risk rating. This is a navigation aid, not a new review verdict. Missing summaries remain missing; stale revisions and dirty review candidates are called out. No server contract or summary-generation service is added.

The selected filename, file mark, current-file preview, file comment action, next unreviewed file, and progress stay outside the scrolling diff. A file comment composer opens beside those controls even when the diff is already scrolled. Existing line comments, snapshot pinning, marks, and review scroll memory remain in use.

Orchestrator switches to the compact layout when its available surface is under 900 pixels, as well as when Paseo reports compact mode. The compact diff has a bounded scroll area, keeping its controls usable without forcing two code columns beside a file tree.

## Validation

- TypeScript typecheck passed.
- 83 focused client tests passed, including new tests for queue refresh/removal, async loading, explicit navigation, unmatched questions, host/task/run/workspace evidence isolation, newest review selection, stale and dirty evidence, and file prioritization.
- Local Paseo plugin reload reports running.
- Live UI checks: guided review entry, next task routing to separate delivery, recorded question fallback, populated and missing review briefs, compact file selection, long diff scrolling with controls retained, and visible file comment composer/cancel. No approval, comment, worker message, queue enrollment, or delivery was submitted.
- Gortex impact and post-edit checks reviewed. Its graph does not recognize all VM-based component tests and retains a broad behavioral-risk advisory for the shared MissionReview component; TypeScript and focused tests cover the changed interfaces.

Only the local plugin is reloaded. No remote installation, publication, worker links, schedules, or supervisor policy changes are part of this batch.
