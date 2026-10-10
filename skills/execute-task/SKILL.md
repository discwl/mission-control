---
name: execute-task
description: Implement the approved scope of one Development Flow task in its linked application workspace and record actual progress without claiming validation.
---

# Execute task

Follow **Agent-managed workspace labels** in `<kitRoot>/docs/agent-workflow.md`. The coordinator uses In Progress for active authorized implementation in a task-owned workspace; Blocked requires a recorded inability to continue with the actual reason, and Paused requires the user's explicit pause. Never change a shared workspace's overall label from one task's state. Re-read and record the actual label assignment; completing implementation does not mean Done.

Load the exact task/run with `check-environment`. Read `plan.md` and the plan decision. Work only within the approved scope, using existing project patterns. Keep one writer in the application workspace while a reviewer examines the candidate. When code changes are complete, simplify any complexity introduced by this change where useful.

Record a factual `execute` event with the shared `dev-flow.mjs record` CLI described by `plan-task`: stage `execute`, outcome `completed`, `blocked`, or `in_progress`, summary of what changed, exact next action, and evidence paths. The CLI captures current Git HEAD and dirty files. Implementation completion does not mean tests, independent review, commit, PR, or delivery passed. Continue with `validate-changes`.
