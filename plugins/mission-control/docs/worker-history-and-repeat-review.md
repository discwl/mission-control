# Worker history and repeat reviews

Open **Workers** beside the chat composer, or use **This chat’s workers** in the Command Center. An orchestrator’s Review dialog also has **Workers & history**.

The list follows native parent relationships and saved Mission Control links for the exact coordinator host and chat. A workspace name or shared checkout never establishes ownership. Children can run on other hosts; descendant relationships include both the parent host and agent ID. Existing saved links are read only for the destination declared by the coordinator workspace’s host.json.

## Worker status and history

- **Active:** Paseo reports an active turn or initialization.
- **Needs you:** a permission, attention request, or error requires intervention.
- **Idle:** no active turn or known completion; closed sessions can also appear here.
- **Completed:** Paseo reported a finished turn. This does not establish task completion, code acceptance, or delivery. Once observed, reading its notification keeps that completion in history until a newer turn starts.
- **Archived:** the conversation was archived on its host. Opening it does not unarchive it.

Host, workspace, relationship, last known activity, and the agent’s summary appear on each row. Missing summaries are explicit. History includes archived agents and paginates up to 1,000 agents per host. A partial host read is labelled. Last activity does not move backwards when Paseo clears a read attention timestamp.

Opening a worker leaves it in this list. Filters and search survive navigation. **Return to orchestrator** appears in the sidebar after opening a worker through Mission Control. It returns to the originating chat, or restores the saved Orchestrator console when opened from that console on its installation. If another installation owns the return screen, the coordinator chat is the fallback; select the original host’s Orchestrator screen to restore its console state. Navigation failures show an error and can be retried.

History is stored on the current device for up to 20 chats and 1,000 workers per chat. It contains identifying metadata and a bounded agent summary, never full conversations or credentials. Offline or missing workers remain visible as saved history. Their navigation is disabled until current ownership and availability are verified. A complete successful refresh removes verified detached or unlinked workers from this chat’s roster. Storage-disabled clients retain live functionality but lose saved history after leaving the view.

## Changes since the previous review visit

The Review header shows **Since opening this review** on a first visit and **Changes since review checkpoint** when a saved comparison exists. Expand it to inspect changed file names, new or changed review parts, and files that are no longer in the current diff. **Show changed files** narrows the file list; **Show all files** restores it.

The comparison uses file paths and content-based review identifiers. Unchanged parts retain existing review marks. File removals and unchanged shown content never establish that a finding was fixed. Comments, unsent drafts, review decisions, and delivery approvals keep their existing behavior.

Changing repository, branch, or comparison base makes the comparison unavailable. A HEAD-based review also becomes incomparable when HEAD changes. A stable branch-point or explicit-commit review can advance HEAD without changing the comparison base. Truncated or omitted content remains explicitly partial. Offline or stale snapshots do not update the saved comparison.

The first current snapshot establishes a comparison point. That checkpoint stays fixed across refreshes, navigation, plugin reloads, and layout changes. Use **Save review checkpoint** after inspecting the current changes to make future comparisons start here. Viewing or resizing a snapshot never acknowledges its changes, marks files reviewed, or approves work.

Only metadata is saved: identity, scope, fingerprint, time, file paths, change identifiers, and counts. Full source and diff lines are not stored. Up to 20 review contexts are retained on this device, scoped by host, workspace, and agent or task review session.

## Validation

Focused model and surface tests cover exact ownership, cross-host descendants, archived pagination, history restoration, completion acknowledgement, bound-host link routing, navigation rollback, comparison identities, scope changes, and partial evidence. Type checking targets the installed Paseo 0.13.2 SDK. Live UI verification uses read-only navigation; it does not launch workers or submit decisions, comments, or delivery actions.
