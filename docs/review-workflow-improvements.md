# Review workflow follow-up — 2026-10-26

This completes the three follow-ups recorded in [the UI workflow review](ui-workflow-review.md): returning to the current review, showing review evidence beside the diff, and retaining unsent decision drafts. It also corrects the misleading Open file action.

## Current file and returning to Review

View current file opens the current file from the selected workspace host in a read-only modal above Review. Back to review closes it without replacing the selected file, change block, layout, pinned snapshot or unsent comments. The file menu uses the same action instead of offering duplicate Open file and Preview file actions.

The modal offers Open workspace, Copy relative path and Copy full host path. The full path is resolved on the exact selected host/workspace. Open workspace uses Paseo's public native workspace navigation with both IDs. To edit, select that path in the workspace's Files view.

Paseo 0.13.2's documented plugin navigation API and the installed SDK expose workspace, agent and browser navigation but no open-file navigation method. File-panel extension support does not provide that missing navigation method. Mission Control therefore does not claim to open an editable native file tab, guess undocumented routes, or open a remote path on Personal. The legacy Working file route remains compatible with saved links and gains honest read-only labels and navigation controls.

References checked: https://paseo.sh/docs/plugins/reference and https://paseo.sh/docs/plugins (2026-10-26).

## Human review checklist

An expandable checklist sits beside the diff on wide layouts and above it on compact layouts. It shows the recorded acceptance criteria, latest validation evidence, independent-review evidence, unresolved findings and the displayed commit/snapshot. Evidence links open the exact task document or run record in Evidence, with Back to review.

The checklist uses existing read-only document/run RPCs. Run identity must match the task, host and workspace. Missing records, partial host data, unknown findings and stale revisions remain visible. A completed workflow event is a recorded update, not proof that validation passed. Reviewer independence requires a different recorded agent from the preceding implementer. Matching commits do not verify uncommitted file contents. Later implementation, a different commit or a stale review snapshot marks results stale. The returned recent records may be incomplete; zero visible findings is not a comprehensive verdict.

Selected task tabs, file-list position and diff positions are scoped by identity and retained for in-app navigation. Pinned code snapshots remain in bounded memory (eight reviews), not browser storage; app/plugin reloads fetch a fresh snapshot. Existing persisted review metadata and comment drafts remain supported.

## Unsent decision drafts

Decision notes, finding choices and a pending change/stop confirmation persist per host, workspace, task, run and decision. On desktop/web they use device-local browser storage; when durable storage is unavailable they remain in session memory. Nothing is sent by restoration. The UI identifies saved drafts, allows explicit discard, and clears a draft only after successful submission or when an empty edit is cancelled.

A draft retains the decision revision on which it was started. If that request changes, submission is blocked until the human reads the current request and explicitly reuses the note. Reusing clears the old confirmation and old finding choices. Plan approval remains tied to its separately verified plan revision. Saving a note does not authorize delivery, publishing or external updates.

## Verification and deployment scope

TypeScript checking passed. The 73 focused tests passed across decision drafts, plan approval, review evidence and timestamp ordering, scroll restoration, file actions/viewer, review sessions, fleet navigation, task flow, linked tasks and page memory.

Live Paseo checks on Personal against the CNS discount-prevention task verified the expanded checklist, its exact validation-record link, Back to review, selection of change block 2/2, current-file modal and return to the same block. Open workspace reached the correct CNS task workspace. An empty change-plan confirmation survived a local plugin reload and was then cancelled; no decision, agent message, review comment or approval was submitted. The local plugin was reloaded and reported running. The expanded checklist and diff were visually checked in Light and Dark themes. A dedicated live compact-width check was not completed: native window sizing did not yield the compact viewport. The original window size and Dark theme were restored.

The live remote task has an older Mission Control server and an older request without a structured, revision-bound plan. The new UI shows that the plan cannot yet be verified. Remote plugin rollout and fresh readable plan requests remain separate work; these local UI changes do not migrate old decisions or update other hosts.

Gortex impact/detection and guard/contract inspection were used. Guard inspection reported no configured rules. Contract inspection reported behavioral/blast-radius advisories for shared client components. These were assessed against typechecking, focused regression tests and the live read-only UI checks; the graph's direct test discovery does not capture all VM-driven component tests. Some automatic view-resolution and multi-symbol checks returned checkout-lane-busy errors; explicit repository detection and individual component checks were usable. No daemon restart or tracking change was made.
