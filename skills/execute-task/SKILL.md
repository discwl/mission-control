---
name: execute-task
description: Implement the approved scope of one Development Flow task in its linked application workspace and record actual progress without claiming validation.
---

# Execute task

Follow **Agent-managed workspace labels** in `<kitRoot>/docs/agent-workflow.md`. The coordinator uses In Progress for active authorized implementation in a task-owned workspace; Blocked requires a recorded inability to continue with the actual reason, and Paused requires the user's explicit pause. Never change a shared workspace's overall label from one task's state. Re-read and record the actual label assignment; completing implementation does not mean Done.

Load the exact task/run with `check-environment`. In manual mode read `plan.md` and the plan decision. In verified automatic mode read the submitted immutable plan and its passing independent plan-review checkpoint; the CLI enforces the current scope, policy and plan revision before recording implementation. Do not create a human approval to satisfy legacy profile wording. For actions/report tasks, prepare a bundle with `dev-flow.mjs save-actions` containing the exact environment, prerequisites, ordered instructions and effects, verification and rollback (plus report when applicable); do not execute those external/production actions. Work only within the approved scope, using existing project patterns. Keep one writer in the application workspace while a reviewer examines the candidate. When code changes are complete, simplify any complexity introduced by this change where useful.

Record a factual `execute` event with the shared `dev-flow.mjs record` CLI described by `plan-task`: stage `execute`, outcome `completed`, `blocked`, or `in_progress`, summary of what changed, exact next action, and evidence paths. The CLI captures current Git HEAD and dirty files. Implementation completion does not mean tests, independent review, commit, PR, or delivery passed. For a managed stage, save an `execute` checkpoint with actual evidence and stop; the runner launches validation. An ordinary event is not a verified checkpoint. For an unmanaged run, continue with `validate-changes`.
