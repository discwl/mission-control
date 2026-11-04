---
name: prepare-delivery
description: Prepare the exact commit, PR, tracker, or merge actions for a reviewed Development Flow task and record which actions are authorized and still pending.
---

# Prepare delivery

Follow **Agent-managed workspace labels** in `<kitRoot>/docs/agent-workflow.md`. The coordinator may use Done only after all required authorized delivery and verification are recorded complete, the task is delivered/closed, and no other task or agent remains active in that workspace. Preparing a delivery, merging a PR, or recording a completed stage alone does not meet that condition. Retain the appropriate prior label while delivery decisions are pending; verify and record final assignments.

In verified automatic mode, final readiness requires the current plan's independent acceptance, passing validation and two different-model reviews of the exact current candidate. For code, both reviews require OCR coverage and Gortex evidence. For actions/report tasks, both reviews bind the exact immutable bundle and do not require fake OCR. Present the completed work, checks and limitations plus the exact proposed outward actions for the user's authorization. A changed candidate invalidates that readiness and any earlier authorization. Do not execute action bundles, push or create even a draft PR merely because machine checks passed.

Load the exact task/run. Confirm the plan scope, validation evidence, current candidate revision, fresh review verdict, and any outstanding decision. Draft the proposed commit message, PR description, tracker transition, and verification/cleanup steps that apply. Identify each outward action separately.

After the user authorizes an exact non-code action bundle and the assigned worker actually executes it, save the execution and verification report inside the current run. Record `stage: "delivery", outcome: "completed", actionRevision: "<authorized bundle SHA256>", evidence: ["<saved report path>"]` with a factual summary and nextAction through `dev-flow.mjs record` using the exact task/run/server/workspace/agent IDs. The CLI verifies the worker, sent authorization, current plan/bundle and hashes the saved evidence before marking action delivery complete. A sent resume, attempted command, or an ordinary handoff is not completion; report failed/partial work honestly and stop for a question when needed.

Use only authorization already granted for that exact action and scope. Plan or review approval does not by itself permit push, PR creation, tracker comments/transitions, merge, or cleanup. Record a `delivery` event with completed actions and pending decisions. Keep a task visible until required verification and follow-up are done; a merged PR alone does not close it. Finish with `write-handoff`.
