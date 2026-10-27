# Reviewing and approving plans

Mission Control separates three human decisions: approve the intended plan, accept the reviewed implementation, and approve the exact delivery action. Plan approval does not authorize pushing, opening a PR, merging, deploying, or posting Jira/ADO comments.

## What to review

Open a task in Orchestrator and choose **Plan**. An open plan decision opens this tab by default. The approval brief must explain:

- The goal and a concrete before/after behavior example.
- Included work, deferred work, affected areas, and scope changes from the original request.
- The implementation approach and observable success checks.
- Risks, tradeoffs, and exactly what approval authorizes next.

For revisions, compare **What changed since the previous proposal** with the previous wording. That comparison identifies changed brief sections; the author's change summary explains the reason. Read the full saved plan below the brief when you need the complete detail. Working documents remain under **Evidence**.

**Approve this plan** approves the displayed saved proposal. **Change the plan** lets you send an editable note; the agent must revise the plan and request a new decision. **Stop** saves the stop decision and instructs the agent to wait. Each action keeps the existing exact task, run, workspace, and host binding.

## Authoring a proposal

Write the complete `plan.md` in the owning task folder before requesting a plan decision with `scripts/dev-flow.mjs`. The request JSON includes the existing question, summary, recommendation and plain-language fields, plus a required `planBrief` object:

| Field | Meaning |
| --- | --- |
| `goal` | Problem and intended outcome |
| `before`, `after` | Concrete behavior before and after the change |
| `included`, `deferred`, `affected` | Explicit scope and affected areas |
| `scopeChange` | Any reduction or expansion from the original request; explicitly state when there is none |
| `approach` | Understandable implementation steps |
| `successChecks` | Observable acceptance checks |
| `risks` | Risks, limitations, and tradeoffs; explicitly state when none are known |
| `authorization` | What the agent may do after approval |
| `changesSincePrevious` | Changes from the previous proposal; an empty list is allowed for the first proposal |

Text fields allow 1–600 characters. Lists require 1–8 text items, except `changesSincePrevious`, which permits 0–8. Use everyday language in the brief; keep file paths, hashes, and identifiers in the full plan/evidence. Revised documents or briefs require a nonempty change summary. See [the planning skill](../skills/plan-task/SKILL.md) for a complete request example.

## Saved versions and older requests

A proposal stores an immutable JSON snapshot under the selected run's `plans/` folder. It contains the complete Markdown, the brief, and the previous proposal's brief/version. Its SHA-256 hash is referenced by the decision record. Snapshot history includes only files referenced by valid matching decision records; interrupted, unpublished requests are excluded.

The client sends both the displayed decision revision and the saved proposal revision on approval. The server verifies the snapshot, exact task/run/decision identity, and current `plan.md` content before saving approval. It repeats the plan check before delayed delivery to a busy agent. A saved approval whose delivery is pending or unconfirmed also blocks supervisor continuation; the Plan tab shows that delivery state. Changed or altered plans require a fresh proposal; approval is never silently transferred to different content.

Older requests have no saved proposal/brief. They can show the current working plan, clearly labelled, and still allow changes or stopping. Approval is unavailable until the agent submits a fresh versioned proposal. **Request readable plan** prepares an editable note and waits for the human to send it. Missing information is never generated from a technical summary.

The owning host must run the updated Mission Control server for `decisions.plan`. Older remote plugins show an update-needed state. Updating the local plugin does not update remote hosts or rewrite their existing decisions.
