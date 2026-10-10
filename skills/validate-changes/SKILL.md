---
name: validate-changes
description: Run the selected application's relevant checks for a Development Flow task and save revision-specific results in its dev-vault run.
---

# Validate changes

Follow **Agent-managed workspace labels** in `<kitRoot>/docs/agent-workflow.md`. Keep the task-owned workspace In Progress while checking the candidate. Passing checks do not imply review, delivery or Done. The coordinator moves it to Review when the candidate actually reaches independent review. Verify assignments on the correct host/workspace and record them with the check evidence; keep native layout validation separate from API tests.

Load the exact task/run with `check-environment`. Choose relevant existing build, test, and lint commands from the project profile and task plan. Run them in the application workspace. Record each command, exit result, important failures, and the Git revision plus dirty state examined. Do not infer a pass from a prior run or from a green UI badge. Label a missing tool or unrelated baseline failure accurately.

Use `dev-flow.mjs record` with stage `validate`, outcome `completed` only when the required checks actually passed, otherwise `blocked` or `in_progress`. Include command/result and output artifact paths in `evidence`, and give an exact `nextAction`. The CLI itself captures current Git state. If code changes after validation, refresh the affected checks before claiming completion. Continue with a fresh `review-changes` pass.
