---
name: write-handoff
description: Save an honest, resumable checkpoint for a Development Flow task in its dev-vault run, including current Git state, blockers, decisions, and exact next action.
---

# Write handoff

Follow **Agent-managed workspace labels** in `<kitRoot>/docs/agent-workflow.md`. Reconcile the workspace label with current task records and live work, and record the verified label plus any unresolved labeling failure in this handoff. A completed handoff never means the task/workspace is Done. Record actual blocker reasons; use Paused only for an explicit user pause. In a shared workspace, retain the coordinator's overall label and describe this task's state separately.

Load the exact task/run with `check-environment`. Check the current workspace and any active builder before calling it stable. Summarize work completed, work remaining, checks and review actually performed, decisions and approvals, blockers, and the first concrete action for the next session. At a material scope change or handoff, compare workspace, agent, and terminal titles with the work they now represent. Leave accurate names unchanged. Suggest a clearer title for a vague or stale name in the handoff; preserve user-chosen names and do not automatically rename titles of unknown provenance. For a rename already authorized and applied through supported Paseo actions, record exact host/resource ID, old/new title, reason, and owner. Follow the Naming checkpoints section of `<kitRoot>/docs/agent-workflow.md`. Do not create a commit or stash just to make the checkout appear clean.

Write a UTF-8 JSON input with `{ "stage":"handoff", "outcome":"completed|waiting|blocked", "summary":"...", "nextAction":"...", "evidence":["artifact or decision references"] }` and call `node <kitRoot>\scripts\dev-flow.mjs record --task <taskId> --run <runId> --server <serverId> --workspace <workspaceId> --cwd <workspace> --input <json-file>`. Remove only the temporary input file afterward. The CLI measures Git state and writes both an append-only event and `handoff.md` inside the run folder.

On resume, compare that saved state with current Git and live task status. A handoff is a dated observation, not authorization to continue outside the approved scope.
