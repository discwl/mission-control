# Mission Control through chat

Mission Control remains the record for plans, reviews, blocking questions, worker links and delivery receipts. Chat displays the saved proposal and submits the same guarded actions as the UI.

## Use it

In a connected Telegram topic, type these commands as ordinary messages. In native Paseo chat, prefix them with `/mc`. The native slash command records consent directly; ordinary agent timeline text is never treated as human approval.

| You want to | Send |
| --- | --- |
| See this coordinator's waiting work | `needs` or `what needs me?` |
| Find older work anywhere on its host | `all needs` |
| Read the saved approval plan | `plan <ticket or task ID>` |
| Accept the displayed proposal | Reply `yes approve` to its Telegram message, or `yes approve <proposal code>` |
| Revise the proposal | Reply `request changes: <what to change>` |
| Stop that task at the decision | Reply `stop: <reason>` |
| Read the code review | `review <ticket or task ID>` |
| Explain acceptance of unresolved findings | Reply `approve: <why you accept them>` |
| Show a blocking question | `question <ticket or question ID>` |
| Answer that question | Reply `answer: <your answer>` |
| Adopt existing work | `adopt <task ID>`; if prompted, add `worker <agent ID>` |
| Refresh an older unreadable plan | `refresh plan <ticket or task ID>` |
| Preview draft PR publication | `draft PR <task ID>` |
| Authorize exactly that draft PR | `open draft PR <proposal code>` |
| Inspect or pause this coordinator | `heartbeat`, `pause heartbeat`, `resume heartbeat` |
| Change this coordinator's queue | `queue <task ID> priority <0–9>` or `unqueue <task ID>` |

If several proposals are pending, use the proposal code or reply to its specific Telegram message. Replying to an unrelated message cannot select a different proposal. Proposal codes expire after 24 hours. Refresh to get a current version. Links open the correct Paseo host, workspace or worker.

## Existing work

No tasks, workspaces, agents, plans, code or PR history are recreated. Recorded worker links define this chat's scope. `all needs` finds older tasks; `adopt` uses an existing worker with exact task metadata and requires a choice if ambiguous. Closed or delivered tasks are not revived. Adoption does not enqueue or approve work.

Older plans without a complete saved approval brief and immutable version must be reissued by their current worker. `refresh plan` requests that in the same task and waits for human approval. Current valid plans can be used immediately. Reviews with missing or changed code candidates cannot be accepted through chat until reviewed again.

## Approval and delivery

Only the paired Telegram owner can perform these Mission Control operations. Operator access to ordinary bot conversations does not grant approval access. A proposal belongs to one coordinator, topic, target host, task, run and revision. Changed plans and changed reviewed code are rejected. Repeated confirmations return the existing receipt instead of replaying a mutation.

Plan and code-review approval do not authorize publication. Draft PR preparation is read-only. Its separate confirmation covers the displayed commit, push and draft PR, with exact repository, branches, content and fingerprint. Other delivery, merge, deployment and Jira/ADO actions retain their separate approval requirements. Native tool permission prompts remain in Paseo.

## Telegram delivery and deployment

The local maintained Telegram fork is `C:\Code\paseo-telegram`, branch `mission-control-chat`, based on upstream v0.2.3. Keep runtime plugin ID `telegram` and existing plugin-data so the bot, ownership and topic routes survive. Run one polling instance only. A registry update can replace these local additions; do not switch sources without reviewing them.

Completed coordinator turns now enqueue later public assistant responses. Private reasoning and tools are excluded. Existing history is baselined at installation. Confirmed ordinary-request replies are suppressed in the follow-up queue. Multipart progress and proposal message IDs persist. A lost Telegram acknowledgement is marked uncertain and is not blindly resent; the connection shows a warning.

Linked pending decisions and questions are checked approximately once a minute and after coordinator completion. Native chat receives cards after coordinator completion. A remote host must be online and running the new Mission Control version for all guarded actions, including current-code review approval. Registered host transport is one-way: it does not pair Personal back onto remote hosts.

## Validation

Focused tests cover owner/topic binding, stale and duplicate consent, uncertain results, exact draft PR authorization, current-code review, saved readable plans, question replies, existing-worker adoption, continuation delivery, multipart proposal replies, offline hosts and revocation. Typecheck both plugins. Use read-only `help`, `needs` and plan previews for production smoke tests; never approve a live business task solely as a test.

Later additions such as quiet-hour digests, snooze, updating an existing draft PR and marking it ready are separate work, not enabled by this implementation.
