# Manual agent cleanup

Mission Control can preview and archive inactive agent families. Use the broom beside a row's pencil for that family, or the bordered broom in the Agents heading for the selected workspace. The Agents panel, workspace page and Mission sidebar share these controls.

Cleanup is available for the host running the selected Mission Control installation. Remote hosts need their own installation and host/vault setup. The RPC checks the actual daemon identity against the vault and requested host before doing any work.

## Using the preview

1. Press the broom. A scan groups families into **Eligible**, **Keep** and **Couldn't verify**, with reasons and the number of conversations that will archive, detach or remain unchanged.
2. Select eligible families. Nothing starts selected. **Select finished task families** excludes unlinked conversations; those require an individual checkbox.
3. Press **Archive selected**. Each selected family is checked again. A changed family is skipped, and an uncertain archive result consumes the preview without an automatic retry.
4. Read the results or **Show recent cleanup**. Results stay visible after the archived row disappears. Use **Scan again** for another operation.

Previews expire after five minutes, are bound to their host/workspace/family scope, and accept at most 100 selected roots. Execution is serialized per host. A preview cannot select an agent that was not eligible in that scan.

## Retention and protections

Set **Settings → Plugins → Mission Control → Agent cleanup** on each host:

| Setting | Default | Meaning |
|---|---:|---|
| Delivered/closed task conversations | 7 days | Retain until the newest family activity or linked task update passes this age. |
| Unlinked conversations | 14 days | Offer old unlinked families for individual manual selection. |

Both settings accept whole numbers from 1 to 365. They apply to manual scans; there is no automatic archive timer.

Cleanup keeps or refuses to verify a family when it has:

- A working/initializing agent, active turn, running internal helper, or unavailable provider/helper check.
- A pending permission, question or plan/review decision, including a decision linked only to the task.
- An unfinished linked task, a newer run after the task update, or a missing task referenced by a label. Every recorded run binding is considered.
- An open chat tab, a pinned workspace, or the explicit `mission-control.cleanup.keep=true` label.
- A missing parent/workspace, parent cycle, incomplete directory/task records, unreadable activity, or invalid/future timestamps.
- A closed task with a recorded pull request whose delivery has not been verified. An unlinked family is also kept when its workspace has unfinished tasks.

Family checks include descendants in other workspaces and legacy parent labels. The preview distinguishes the native archive cascade, children that detach and remain, and legacy members that remain unchanged.

Idle agents use recent conversation entries and the latest user prompt for activity. Closed, errored, archived, busy or provider-unavailable agents are not read through the timeline; known timestamps provide a conservative bound. Failed reads never establish eligibility.

## What cleanup preserves

Manual agent cleanup archives conversations while retaining their history. It preserves task records, workspaces, branches and files. A merged pull request offers **Check delivery cleanup**, which opens the existing separate checks before workspace archival, branch deletion and marking the task delivered.

Cleanup receipts are saved under `PASEO_HOME/plugin-data/mission-control/agent-cleanup/history.json`, or `~/.paseo/plugin-data/mission-control/agent-cleanup/history.json` when `PASEO_HOME` is unset. The file retains the latest 500 host receipts; the dialog shows the latest 30 for its workspace. An intent receipt is persisted before archive. A corrupt or unwritable history prevents starting the operation.

Paseo's archive API has no atomic “archive only if still idle” precondition. Mission Control rechecks records and the family directory immediately before calling it, but another client starting work at that exact boundary remains a race. Do not treat the checks as an atomic lock over all Paseo clients.

## Verification

Regression tests cover retention, family traversal, task/input protections, stale previews, exact scope, duplicate/concurrent execution, archive receipts, stopped-agent activity reads and UI/settings interactions. They use synthetic agents and mocked host APIs; no real agent is archived by the tests.

```powershell
cd C:\Code\development-flow\plugins\mission-control
npm run typecheck
node --experimental-strip-types --test server/agent-cleanup-engine.test.mjs server/agent-cleanup.test.mjs client/agent-cleanup.test.mjs client/agent-cleanup-panels.test.mjs
```

Native visual verification is a separate check: confirm the header broom matches the pencil/refresh buttons, that the preview fits narrow panels, and that results remain readable after a row disappears.

See the [user guide](user-guide/mission-control-user-guide.html#agent-cleanup) for the UI walkthrough.
