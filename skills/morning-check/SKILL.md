---
name: morning-check
description: Run the manual Morning check on one host; read the user's current-sprint Jira or Azure DevOps items (read only), compare them with Mission Control tasks by ticket, review the previous day's work, and write the morning report in the host's dev-vault.
---

# Morning check

Mission Control starts this skill from a workspace's **Morning check** action; the user can also ask for it directly. It reports. It does not import tasks, change task status, or start other work: the user picks imports in Mission Control.

**Read only.** Never create, edit, transition, assign, link, log work on, or comment on anything in Jira or Azure DevOps. Use only search, query and get calls. If a tool call would change the tracker, don't make it.

## 1. Identify the host

Read `C:\dev-vault\host.json` for this host's `serverId`. The kit root is the folder that holds this skill's `skills` folder; the report script is `<kitRoot>\scripts\morning-check.mjs`.

## 2. Collect the current-sprint items

Use whatever Jira or Azure DevOps MCP tools this session has. Mission Control does not call the trackers itself.

- **Jira:** search with JQL like `assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC`.
- **Azure DevOps:** find the work items assigned to the user in the team's current iteration, for example WIQL `[System.AssignedTo] = @Me AND [System.IterationPath] = @CurrentIteration`.
- If the session has both, read both. If a query fails, record the error in your notes and continue with what you have.

Write the items to a temporary UTF-8 JSON file (use the Write tool: shell heredocs can corrupt backslashes):

```json
{ "items": [
  { "system": "jira", "key": "ABC-123", "url": "https://example.atlassian.net/browse/ABC-123", "type": "Story",
    "title": "Summary", "description": "Plain-text description", "acceptanceCriteria": "If the ticket has a field for it",
    "status": "In Progress", "sprint": "Sprint 42" },
  { "system": "azure-devops", "key": "48213", "url": "https://dev.azure.com/org/project/_workitems/edit/48213", "type": "Bug",
    "title": "Title", "description": "", "acceptanceCriteria": "Microsoft.VSTS.Common.AcceptanceCriteria as plain text",
    "status": "Active", "sprint": "Project\\Iteration 7" }
] }
```

`system` is `jira` or `azure-devops`. `key` is the Jira issue key or the Azure DevOps work item ID. `url` is the item's browser link. Add `type` when you know it: the Jira issue type or Azure DevOps work item type, for example `"type": "Bug"` or `"type": "User Story"`. Mission Control uses it for `feature/` or `bugfix/` branch names. Convert HTML or Atlassian markup to plain text. Keep at most 200 items.

## 3. Write the report

Optionally write a short notes file: which tools and queries you used, how many items each returned, and any errors. Then run one of:

```powershell
$kit = '<kitRoot>'
node "$kit\scripts\morning-check.mjs" report --server <serverId> --tracker read --items <items.json> --notes <notes.md> --agent <your agent ID>
# No Jira or Azure DevOps tools in this session: say so in the notes.
node "$kit\scripts\morning-check.mjs" report --server <serverId> --tracker unavailable --notes <notes.md> --agent <your agent ID>
# Test without a tracker (Mission Control's "Use test fixture"):
node "$kit\scripts\morning-check.mjs" report --server <serverId> --tracker fixture --agent <your agent ID>
```

By default the review covers work since the start of the previous day. On a Monday, or when the user asks, pass `--since <ISO time>`, for example the previous Friday morning.

The script compares items with the vault's tasks by ticket (system and key, ignoring case), reviews handoffs, open Needs you decisions, and blocked or idle tasks, and writes `C:\dev-vault\Daily\morning-<date>-<time>.md`. Its format is in `docs/agent-workflow.md` under "Morning check report". Remove only your own temporary files afterwards.

## 4. Report back

Give the report path and a short summary: the items not in Mission Control yet, open decisions, blocked and idle tasks, and anything you could not read. Tell the user to pick imports in Mission Control → the workspace page → **Morning check**. A report is an observation, not approval of any task, plan or review.
