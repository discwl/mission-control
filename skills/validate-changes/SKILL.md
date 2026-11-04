---
name: validate-changes
description: Run the selected application's relevant checks for a Development Flow task and save revision-specific results in its dev-vault run.
---

# Validate changes

Follow **Agent-managed workspace labels** in `<kitRoot>/docs/agent-workflow.md`. Keep the task-owned workspace In Progress while checking the candidate. Passing checks do not imply review, delivery or Done. The coordinator moves it to Review when the candidate actually reaches independent review. Verify assignments on the correct host/workspace and record them with the check evidence; keep native layout validation separate from API tests.

Load the exact task/run with `check-environment`. In automatic mode validation precedes both independent reviews, and any revised candidate requires fresh validation and both reviews. For an actions/report task validate the exact saved bundle: prerequisites, targets/environment, command or script correctness, expected effects, verification and rollback. Run only authorized safe local checks; do not execute the prepared actions or claim live checks that did not run. For code, choose relevant existing build, test, and lint commands from the project profile and task plan. Run them in the application workspace. Record each command, exit result, important failures, and the Git revision plus dirty state examined. Do not infer a pass from a prior run or from a green UI badge. Label a missing tool or unrelated baseline failure accurately.

Use `dev-flow.mjs record` with stage `validate`, outcome `completed` only when the required checks actually passed, otherwise `blocked` or `in_progress`. Include command/result and output artifact paths in `evidence`, and give an exact `nextAction`. The CLI itself captures current Git state. If code changes after validation, refresh the affected checks before claiming completion. For a managed stage, save a `validate` checkpoint with evidence tied to the assigned code or artifact candidate and stop. The runner launches fresh independent reviewers sequentially. For an unmanaged run, continue with a fresh `review-changes` pass.
