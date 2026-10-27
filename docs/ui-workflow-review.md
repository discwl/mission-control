# Orchestrator workflow UI check — 2026-10-26

The local Mission Control plugin was reloaded and checked in the running Paseo desktop app. Checks used existing remote data without approving decisions, sending notes, changing worker links, enrolling coordinators, queuing tasks, or starting work.

## Improvements included

- A **Plans** list counts and finds open plan proposals even when another recorded question makes the workflow stage Blocked.
- Task actions say **Review plan**, **Answer question**, **Review result**, **Review code**, or **Review delivery**, and open the matching task view.
- Plan and Review use a compact header. Plan and Needs you tabs show pending counts. Plan cards display host/project/workspace names instead of internal IDs.
- Repetitive host connection and compatibility warnings share one expandable summary. Unavailable hosts remain named, and dispatch still waits on incomplete data.
- Host filter buttons sort by name so asynchronous refreshes do not move the click targets.
- Switching the fleet view resets the stage filter; selecting Delivered explicitly allows delivered tasks into the list.
- Plan approval includes a readable brief, the full saved document, revision comparison, and an exact saved-version check. Older requests clearly require a fresh proposal.

## Observed UI results

The CNS discount-prevention task appeared under Plans despite also having an older open question. Review plan opened its Plan tab. Host/project/workspace names were readable, and the two pending requests were visible in the tab count.

CNS currently lacks the new `decisions.plan` RPC. The UI showed the update-needed state and disabled approval. Request readable plan opened a prefilled, editable confirmation. Clicking inside the note kept it open; Cancel dismissed it without sending.

The same task's code review loaded a current two-file snapshot with file tree, counts, split diff, and Open file. Open file loaded the correct current CNS working file in the existing read-only fallback screen. The task Review pane remained substantially taller than before the layout change.

The structured brief, previous-wording comparison, Markdown rendering input, query isolation, request-change draft preservation during refresh, and exact approval versions were exercised with synthetic component/store tests. The new structured brief was **not** verified against a newly authored live remote proposal. That requires the remote plugin update and a fresh proposal; the UI check deliberately did not rewrite existing decisions or ask agents to work.

## Recommended follow-ups

1. **Preserve review context when opening files.** The fallback Working file screen has no explicit Back to review action and shows a workspace ID. Carry the originating host/task/tab/file selection through navigation, provide a visible return action, and preserve scroll position. This should cover both Orchestrator and ordinary workspace reviews.
2. **Add a human review checklist beside the diff.** Summarize acceptance criteria, validation outcomes, independent review status, remaining findings, and the exact reviewed revision. Link each item to its evidence and mark missing/stale evidence explicitly. A raw file diff alone cannot establish that a task is ready to accept.
3. **Retain unsent decision notes across navigation.** Notes now survive background refresh while the card remains mounted. Moving between task tabs/screens should also preserve a task/decision-scoped draft and clearly separate saved drafts from sent instructions.

These follow-ups need coordinated navigation/evidence/draft behavior across screens; they were not added as incidental styling changes. Publication and remote plugin rollout remain separate from this local implementation.
