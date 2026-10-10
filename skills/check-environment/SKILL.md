---
name: check-environment
description: Start or resume a Development Flow task linked to a Paseo workspace and C:\dev-vault; verify its exact identity, project profile, Git state, and handoff before work.
---

# Check environment

At every start/resume, also read **Agent-managed workspace labels** in `<kitRoot>/docs/agent-workflow.md` after verifying the task binding below. Inspect the live label catalog, exact workspace and linked tasks with `node <kitRoot>\scripts\dev-flow.mjs workspace-label --task <taskId> --server <serverId> --workspace <workspaceId> --cwd <checkout> --action get`. Use that command's guarded `status` action for task-owned workspace checkpoints, or explicit coordinator/user `assign`/`remove` actions for shared-workspace choices. The workspace coordinator owns any change; a worker or one task in a shared workspace must not replace its overall status. Preserve unrelated tags and user-selected labels, verify every applied change by re-reading the workspace, and record its receipt in the current stage evidence. Labels never approve work or replace task/run records; a label API error must be reported without blocking unrelated authorized work.

Use the exact `taskId`, `serverId`, and `workspaceId` supplied by Mission Control's `/mission-task` command or the user. If any is missing or several tasks could apply, request the selected task instead of guessing.

Read the task record in `C:\dev-vault\Tasks\<taskId>\task.md`. Match its `projectId` to one file in `C:\dev-vault\Projects\`, then find that profile's `kitRoot`. Run:

```text
node <kitRoot>\scripts\dev-flow.mjs context --task <taskId> --server <serverId> --workspace <workspaceId> --cwd <current application workspace>
```

The command verifies host, assignment, project repository, and current Git state. Read its task, profile, latest run, handoff, and the run's `decisions`, `findings`, `questions`, and `workflowInstructions`. The latter contains the effective host/project Intake and Planning guidance, source note paths and revision. Apply the named guidance during that stage and re-read context on each start/resume. Missing notes mean no extra guidance; malformed or unreadable notes are reported and must be corrected before relying on them. Reuse the user's existing answers and scope confirmation; ask through Needs you only for unresolved requirements. Instruction notes do not grant new tool access or tracker/database writes, override repository rules, or add delivery permission. An `open` decision means the user has not answered: report it and wait. A resolved decision's status and note tell you what the user approved, asked to change, or blocked. Reconcile the handoff with current Git before resuming; report any drift. Check the tools and configured validation commands needed for this task. A task's displayed status grants no execution, review, or delivery permission.

If no run exists and the task is ready to work, call the same CLI with `start` in place of `context`. If a run exists, continue that run unless a distinct new attempt is intended. Report the selected task/run IDs, actual readiness, blockers, and next action. Keep Obsidian optional; these are ordinary vault files.
