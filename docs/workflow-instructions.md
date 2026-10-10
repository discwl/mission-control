# Host and project workflow instructions

Open **Settings → Plugins → Mission Control → Workflow instructions** on the intended Paseo host. Save separate **Intake** and **Planning** guidance under **Host defaults**, then select a project for its exceptions. The screen lists that host's actual Paseo projects.

For each project and each stage:

| Choice | Effective guidance |
|---|---|
| Inherit host | Host text only; project text is retained but inactive. |
| Add to host | Host text followed by project text. |
| Replace host | Project text only. Empty project text removes the host's custom guidance for that stage. |

The **Effective guidance** preview updates while editing and shows the source note paths. Each saved field accepts up to 8,000 characters. Save or discard edits before switching scope. A save from another client does not replace your draft; discard and reload before editing the newer revision. A failed save leaves your text available to retry.

## What to put here

Use host defaults for recurring working preferences and project overrides for the relevant tracker, business rules and information sources. Include enough detail to identify the sources; do not put credentials in these notes.

Example Intake guidance for a host whose Jira tickets often lack detail:

> Before planning, check whether the ticket explains the business goal, expected behavior and acceptance criteria. Reuse context and answers I already supplied. If a material requirement is missing, ask me a focused question through Needs you and wait for the answer. Consult the ticket's linked Confluence page when it is available. Do not invent missing business rules.

Example Planning guidance for a project with a reporting database:

> Consult the project's Confluence design page and inspect the relevant schema using the configured read-only database tools. Confirm unresolved reporting rules with me. Do not change production data. Include checks for the agreed acceptance criteria and note any information source you could not access.

You can name a Confluence space/page, documentation URL, database connection alias, relevant tables, and the specific checks to perform. **Tools & skills** and the provider's configuration manage actual connections and sign-in. Listing a source here does not make it available to the agent.

Task-specific context stays with the task's brief, notes and acceptance criteria. Shared skills define the common workflow; repository rules continue to govern code changes. These guidance notes do not grant new access, tracker/database writes, approval or delivery permission. Conflicting requirements need a decision. Clarification guidance reuses already answered questions and standing authorization rather than asking for the same confirmation again.

## When agents receive it

- **Morning check:** receives the selected workspace project's effective Intake guidance alongside its existing read-only tracker instructions. It still imports only the items the user chooses.
- **Task Start / Resume and `/mission-task`:** resolve the exact bound host and project and include both stages in the task prompt.
- **`dev-flow.mjs context`:** reads the same notes and returns `workflowInstructions` with the effective text, source paths, revision and prompt. `check-environment`, `intake-task` and `plan-task` use that context.

Saving does not interrupt an active agent. New guidance reaches it on its next launch, resume or context read. Ordinary chats outside the task workflow do not automatically receive these notes. Missing notes mean no custom guidance. Invalid, unreadable or misidentified notes produce an error instead of falling back silently.

After updating a host, check **Setup** so its project profiles and skill links use the current complete kit. Older copied skills or an old kit will not consume the new context field.

## Vault storage and manual editing

Notes are outside the plugin checkout and survive plugin updates:

```text
C:\dev-vault\Workflow\host.md
C:\dev-vault\Workflow\Projects\<actual-project-id>.md
```

The host note serves the host declared by that vault's `host.json`. Project notes carry that same host identity and their actual project ID. Do not copy another host's notes without reconciling those fields, and do not edit `host.json` to add workflow settings.

The settings screen creates notes on the first save. They are ordinary Markdown with JSON-valued identity frontmatter, visible Intake/Planning headings, and invisible `<!-- mission-control:intake -->` / `<!-- mission-control:planning -->` section markers. Obsidian renders the guidance as normal text. If editing manually, keep the identity, mode fields, headings and both markers intact; change the text below the relevant marker. Those marker prefixes are reserved and cannot be used inside instruction text. A malformed note must be corrected before that guidance can be loaded.

Writes check the original revision and replace only the selected note. Linked note files/folders and paths outside the vault are refused. If a host process exits during a save, a `.instructions-write.lock` may remain in `Workflow`; verify no save is active before removing that exact stale lock and retrying. Do not remove unrelated vault files.

## Verify on a host

1. Save a small host Intake note, such as “Ask about missing acceptance criteria.”
2. Select a project and choose **Add to host** with a harmless project-specific reference. Confirm the effective preview includes both texts. Switch Planning to **Replace host** and verify its independent behavior.
3. Save, reopen settings and confirm the values remain. Check the two note paths in the vault.
4. Run `dev-flow.mjs context` for a prepared task with its actual task/server/workspace IDs and checkout. Confirm the returned `workflowInstructions` identifies this host/project and includes the effective guidance.
5. Start or resume a disposable task agent and confirm its task prompt contains the guidance. Use an intentionally incomplete test task to check its Needs you clarification. Stop at the normal human review boundary.

Automated coverage checks inheritance and replacement, persistence, concurrent saves, invalid notes, host/project isolation, task prompt and Morning check integration, workflow CLI context, and settings drafts/error feedback. Desktop/mobile visual verification of the new screen remains pending.
