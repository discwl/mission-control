---
name: prepare-delivery
description: Prepare the exact commit, PR, tracker, or merge actions for a reviewed Development Flow task and record which actions are authorized and still pending.
---

# Prepare delivery

Follow **Agent-managed workspace labels** in `<kitRoot>/docs/agent-workflow.md`. The coordinator may use Done only after all required authorized delivery and verification are recorded complete, the task is delivered/closed, and no other task or agent remains active in that workspace. Preparing a delivery, merging a PR, or recording a completed stage alone does not meet that condition. Retain the appropriate prior label while delivery decisions are pending; verify and record final assignments.

Load the exact task/run. Confirm the plan scope, validation evidence, current candidate revision, fresh review verdict, and any outstanding decision. Draft the proposed commit message, PR description, tracker transition, and verification/cleanup steps that apply. Identify each outward action separately.

Use only authorization already granted for that exact action and scope. Plan or review approval does not by itself permit push, PR creation, tracker comments/transitions, merge, or cleanup. Record a `delivery` event with completed actions and pending decisions. Keep a task visible until required verification and follow-up are done; a merged PR alone does not close it. Finish with `write-handoff`.
