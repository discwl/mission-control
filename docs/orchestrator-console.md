# Orchestrator console

Open **Orchestrator** from the sidebar, Command Center, or `/orchestrator` on the daemon hosting your orchestrator folders. Existing `host.json` bindings identify remote hosts. Coordinators created by setup agents in another workspace are included; helpers within the same coordinator workspace are excluded.

## Ownership and workflow

Native parent identities and saved Mission Control worker links establish ownership, including exact host IDs. Descendants inherit their worker's task unless they have a different task label. Titles, paths, and recent activity never establish ownership. Use **Supervisor → Link existing workers** for older work. Linking neither launches work nor claims authorship of shared files. Investigation workers appear without a task; automatic continuation requires a recorded, owned task.

Overview shows active tasks and workers. Work queue shows explicitly queued tasks. Needs you and Review identify the next human/review step. Activity retains 500 workflow and supervisor events. The visit marker uses the app's page memory. Offline and incomplete data is shown as unknown.

Stages follow existing task, run, decision, and question records: intake, planning, plan approval, implementation, validation, independent code review, your review, separate delivery approval, and delivered. A finished turn does not establish successful validation, current revision approval, or delivery. The console reports recorded evidence; existing delivery checks remain authoritative for revision-sensitive actions.

Task details include acceptance criteria, managed workers, task-specific attention, files/diffs with Open file, run/document evidence, and delivery controls. Workspace diffs may include other agents' work. Request-changes controls reuse saved feedback; component keys do not depend on refresh revisions.

## Continuous operation

Automatic work is off until the user both enrolls a coordinator and queues an owned task. The plugin checks every 30 seconds, with each coordinator's 5–120 minute interval and 1–96 wake-ups per UTC day (UI presets are narrower). Defaults are five minutes and 24 wake-ups. This is not a spending cap.

A wake-up sends one scoped continuation to the existing coordinator. It rereads ownership and task state immediately before sending, then instructs the coordinator to reconcile `mc status/context`, reuse its worker through `mc start`, and advance only that task. Native completion notifications remain handled by Paseo. There is no catch-up burst after downtime.

Dispatch waits for busy agents/shared workspaces, incomplete or stale data, paused/Done/Blocked workspaces, archived workers, manual stops, permissions, questions, errors, open decisions, missing plan approval, and uncertain sends. Three wake-ups without changed task evidence or the daily cap stop continuation. Other eligible tasks/hosts can progress.

At most two managed hosts are active according to observed snapshots; this does not constrain independently started work. State revisions and an exclusive writer lock prevent duplicate reservations. Intent is saved before sending. Lost acknowledgements remain pending and are never blindly resent. Inspect the coordinator, clear the attempt, and explicitly reenable it.

**Pause all wake-ups** prevents future continuations without interrupting running turns. Canceling a coordinator disables it. A canceled worker stays excluded until a new explicit turn clears its stop record. The daemon and computer must stay running and awake. Windows startup/sleep settings, credentials, subscriptions, and provider limits are unchanged.

## Approval boundary

The supervisor never calls merge, PR, tracker, deployment, or permission-resolution actions. Its continuation explicitly prohibits external writes and requires approval for the exact action, content, and destination. Review acceptance and delivery approval remain separate.

Agents retain their configured tool permissions. This scheduler is not a sandbox for arbitrary shell commands or third-party tools. Review permissions before unattended work, especially Full access/Bypass sessions. Existing delivery enforces its PR/merge checks; a general Jira/ADO comment approval executor, automatic provider switching, quota recovery, and bulk coordinator ownership transfer are not included.

## Compatibility and rollout

Targets Paseo 0.13.2. The transport adapter uses its internal DaemonClient and host-channel APIs because the public server SDK lacks plugin RPC routing. It opens existing one-way routes and never registers Personal remotely.

New remote copies expose `orchestrator.host.snapshot` beside their vault. Older copies supply managed work through existing roster/task/run/decision/question APIs. This compatibility view lacks older decisions and manual stop history, so it cannot dispatch automatically.

Rollout: validate locally; inspect the reloaded directory plugin; obtain approval for publishing the concrete change and updating remote plugins; verify exact host identities and complete snapshots; then enroll one coordinator and queue a small approved task before expanding enrollment. Historical tasks are never enrolled automatically.

## Persistence and recovery

State lives in `$PASEO_HOME/plugin-data/mission-control/fleet.json` (normally `~/.paseo/plugin-data/mission-control/fleet.json`). It contains queue, enrollment, counts, pending sends, stop records, observation fingerprints, and events. Writes use an exclusive lock, revision checks, a synced temporary file, and atomic replacement. Corrupt state is preserved and stops automatic work.

A hard crash during writing can leave `fleet.json.lock`. Stop the affected plugin, inspect the lock owner and pending attempt, preserve state, then remove only the abandoned lock before reloading. Never remove a live writer's lock. Pending dispatches still need explicit reconciliation; locks are not stolen automatically.

Paseo 0.13.2 lacks atomic send-if-idle. The supervisor refreshes immediately before sending and requests steering behavior. A concurrent transition in that final gap is a platform limitation; known active turns are not intentionally interrupted.

## Local validation — 2026-10-26

- Typecheck passed. All 20 focused fleet/runtime tests passed, covering ownership, approval gates, manual stops, incomplete snapshots, two-writer dispatch, restart recovery, uncertain acknowledgements, and concurrency limits including descendants.
- The broad `node --test` run passed 739 cases and failed 17. Fourteen test files needed Node 22's `--experimental-strip-types`; rerunning those files passed all 82 contained tests. Three existing PR polling tests passed individually after timing out during the broad run. No production changes were made for these runner/timing failures.
- The local directory plugin reloaded successfully and displayed all eight bound hosts. Manual UI checks covered host/chat filters, task details, remote files/evidence, and compact layout. No live task was queued, coordinator enrolled, or continuation sent.
- Gortex's mutation lane intermittently rejected checks. A partial change detection and supervisor contract check completed; the contract warned about behavioral change risk. Full graph verification remains incomplete, so it is not recorded as a clean pass.
- Remote copies remain on their existing release. Publishing, rollout, and the first live queued continuation await explicit approval.
