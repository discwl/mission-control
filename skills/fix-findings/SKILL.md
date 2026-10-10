---
name: fix-findings
description: Investigate substantiated review findings for one Development Flow task, fix them within approved scope, and request fresh validation and review.
---

# Fix findings

Follow **Agent-managed workspace labels** in `<kitRoot>/docs/agent-workflow.md`: the coordinator returns a task-owned workspace to In Progress when approved fixes begin, then Review for the revised candidate's fresh review. Keep explicit blockers/pauses distinct from waiting decisions. Preserve other tasks' and user-selected workspace labels, and verify and record any label changes.

Load the exact task/run, the review artifact, and the user's decision (`dev-flow.mjs decision --run <runId> --decision <decisionId>`). Fix only findings the user marked `submitted`; dismissed findings stay dismissed. Investigate each finding against the actual candidate and relevant code relationships. Record why it is valid, already guarded, or unresolved. Fix valid defects within the approved scope; do not weaken a meaningful test to make a review pass.

After fixing one, run `dev-flow.mjs finding --run <runId> --finding <id> --status awaiting_verification --evidence "<files changed and checks run>"`. Never mark a finding `resolved`; only a fresh review's evidence does that. Record a `fix` event with the changed files, fixed and remaining finding IDs, and next action. Rerun affected validation and obtain review of the revised candidate. Start with at most two fix/validate/review rounds; after that, hand unresolved items to the user with evidence. An earlier review verdict is stale for changed code.
