# Run to draft PR

Open **Orchestrator → Run to draft PR**. Choose a coordinator and either an existing task or **Start from a ticket or new task**. New intake saves a normal Mission Control task in the selected host and workspace before planning. Retries use the same intake ID and task ID.

The workflow is:

1. Prepare a readable implementation plan in the task.
2. Wait for your plan approval.
3. Implement the approved scope and save a checkpoint.
4. Run checks against that exact code revision and save actual evidence.
5. Start a fresh independent reviewer. Its agent must differ from the implementer and fixers.
6. Wait for your code review decision. Up to two substantiated repairs can be dispatched within the approved scope. Material scope changes require a revised plan.
7. Prepare the exact draft PR preview after code acceptance.
8. Wait for separate publication approval. Only the existing delivery service executes an explicitly approved commit/push/draft PR action.

Plan approval, code acceptance and publication are separate. The runner never answers a question, grants a permission, approves its own plan or review, merges, deploys, or posts tracker updates. Agents keep their configured tools and permissions; the runner controls dispatch and checks saved records rather than sandboxing those tools.

## Existing work

Use `adopt <task ID>` in the coordinator chat to attach an existing worker, then `run to draft PR <task ID>`. Adoption preserves task/run IDs, code, workspaces, decisions and history. A task with a recorded PR continues through that PR rather than opening another. A plan is reused only when its saved version still matches the working plan. Older plans without a versioned approval brief need a fresh proposal. Existing implementation can be inspected and attested rather than rebuilt; missing or stale validation/review checkpoints must be produced again.

Chat controls:

```text
run to draft PR <task ID>
pipeline <task ID>
pause pipeline <task ID>
resume pipeline <task ID>
stop pipeline <task ID>
```

In native Paseo chat, use `/mc` followed by the command. In the paired owner's Telegram topic, send the command directly. An ordinary discussion with an agent is not an approval receipt. Reply to the current displayed proposal with its exact approval code. Draft PR publication requires `open draft PR <proposal code>`; generic plan/review consent cannot publish.

Telegram also receives current task decisions, blocking runner messages and ready draft PR previews. `review details <task ID>` opens the full technical review; the default review notice uses the saved owner brief, reported checks and limitations. Missing facts in older briefs are labelled rather than inferred.

## Heartbeat and recovery

The daemon checks every 30 seconds. A runner's stages are dispatched at least five minutes apart, and at most 24 times per UTC day.

A host can hold several automatic runners, one per task. They form a queue served in the order they were started.

Each host runs one stage at a time. While a coordinator chat or any stage worker on that host is working, nothing else is dispatched there. Hosts run in parallel. A runner that dispatched in the last five minutes lets the next runner on its host go first.

A manual runner drives its coordinator chat, so only one live manual runner may own a coordinator or host at a time. The general queue can't dispatch competing work for a task that a runner owns, and starting a runner removes that task from the general queue.

An automatic code task gets its own worktree and branch before planning, created the way Start creates one. While the worktree is being created the runner shows "Creating the task's worktree". If creation fails, the runner is blocked with the reason, and resuming tries again. An automatic run that already lives in the shared project checkout is blocked, because a draft PR can only be published from the task's own branch.

`automate pipeline <task ID>` switches a task's manual run to automatic checks in one step. The task's open plan and code-review requests are marked superseded, never approved, and no message goes to the old worker. Its earlier workers stop gating new stages, though anything still working in the task's worktree does. A run with your stop or change request, or one in the shared project checkout, can't be switched.

Questions, permissions, worker errors, incomplete host data and manually stopped workers prevent automatic dispatch. The fleet pause and coordinator heartbeat pause also pause future runner stages. Pausing or stopping does not cancel an already running agent turn. Nothing catches up in a burst after downtime.

Stage checkpoints bind the task/run/host/workspace, saved plan version, actual HEAD/tree, author and hashes of saved evidence files. The CLI records what the author reports; it does not independently run tests. Changing the code invalidates earlier candidate evidence. Changing a report invalidates its checkpoint. Use unique report filenames inside the exact run and call:

```text
dev-flow.mjs checkpoint --task ID --server ID --workspace ID --run ID --agent ACTUAL_AUTHOR --input JSON
```

The JSON contains `stage` (`execute`, `fix`, `validate`, `review`), `verdict` (`pass`, `repair`, `blocked`), `scope` (`approved`, `needs_plan`), a concise `summary`, and one to ten evidence-file paths. A verified versioned plan approval is required. Self-review is refused before a completed-review event is written.

Dispatch intent is saved before a message is sent. A missing acknowledgment is retained across restarts and never replayed automatically. Inspect the coordinator's exact pending message, confirm whether it arrived in the runner view, then resume separately. A worker that finishes without a checkpoint requires inspection before another dispatch. A changed active run also requires an explicit resume to adopt it.

Remote calls use existing one-way host registrations. Personal is not registered on remote hosts. Old hosts must update Mission Control before native intake/checkpoint automation can proceed.
