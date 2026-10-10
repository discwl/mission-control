# Talat meeting capture into the Obsidian vault

Updated 2 October 2026. **Talat is the chosen meeting app and is already working well, according to the user.** Its native Obsidian export is the selected path into the vault. This replaces the 19 September Meetily Pro preference and OpenWhispr fallback plan.

The goal is to retain meeting evidence beside the host's project and task records, then use it to clarify requirements and propose work. This documentation update does not configure Talat, verify exports on additional hosts, or implement automatic meeting ingestion in Mission Control. Hermes remains on hold.

## Current capability and remaining work

| Area | Current position | Next step |
|---|---|---|
| Meeting capture | User reports Talat is working well. | Keep the working setup; check audio again when changing host or devices. |
| Obsidian export | Talat supports native Markdown folder exports. The user intends to use this integration. | Configure and verify the destination on the machine attending meetings. |
| Meeting context | Exported files can retain the meeting evidence. | Build processing that links the owning project and daily note while preserving the source. |
| Development intake | Existing tasks use the host's Jira or Azure DevOps configuration. | Present meeting actions for clarification and approval before creating tasks or changing the tracker. |
| Schedules and UI | Meeting-aware coordination is planned. | Add ingestion receipts, pending-work visibility and reconciliation to the existing coordinator design. |

## Configure Talat exports

Use Talat's [Obsidian integration](https://talat.app/docs/integrations/obsidian) on the host where you attend meetings:

1. Open **Settings → Exports → Post-meeting actions**.
2. Add a **Markdown file** action and choose `C:\dev-vault\Meetings\Talat`.
3. Use the optional `{year}/{month}` subfolder rule.
4. Start with **Frontmatter note**. In **Document templates**, retain `{summary}` and `{transcript:timestamps}`, and include your meeting notes. Preview the result before relying on it.
5. Optionally copy audio beside the note if you want it retained in the vault and recording is enabled.
6. Finish a short meeting and check the resulting Markdown in Obsidian.

Talat performs its folder action after post-processing; the exported content depends on the selected template. Existing recordings can be backfilled with the action's **Export all** control. [Exports](https://talat.app/docs/recordings/exports), [meeting completion](https://talat.app/docs/recordings/end-a-meeting)

Keep the export folder separate from agent-written interpretations. For the first pilot, leave automatic export renaming off so source links stay stable. If you enable it later, test link reconciliation. Changing the subfolder rule does not move old files; backfilling into a new layout can leave earlier copies. These cases belong in ingestion tests. [Export filenames and backfill](https://talat.app/docs/recordings/exports)

No custom vault writer, Obsidian community plugin or webhook receiver is required for this initial folder-export path. Do not deploy recording on hosts where you do not attend meetings. The vault and destination paths belong to the recording host, including when you control it remotely.

## File ownership and project routing

The following layout is our recommended convention; it is not a Talat default or an already implemented Mission Control importer.

| Vault location | Owner and purpose |
|---|---|
| `Meetings/Talat/YYYY/MM/<exported filename>.md` | Talat export containing source meeting content; agents read it without rewriting or moving it. |
| Audio beside an exported note, if enabled | Talat recording evidence; keep the original filename relationship. |
| `Meetings/Processed/<meeting-key>.md` | Planned agent-maintained context note with a source link, project links, supported decisions and proposed actions. |
| The host's existing daily note | Planned link to the meeting, added through the daily-rollup owner. |
| `Projects/<project>.md` and relevant task/spec records | Existing project profiles and work records; link meeting evidence without replacing configuration or specifications. |

An Obsidian vault is a folder of Markdown files. Talat's exports appear there directly; Mission Control's Docs browser can read vault documents through its existing file-browsing functionality. This does not establish meeting-specific UI, processing or task creation.

The future processor should record the source host, source file, revision and ingestion receipt. Use a verified Talat meeting ID when available; do not invent Markdown metadata fields or treat a generated title as a unique ID. Deduplicate repeated exports, distinguish changed content from a second meeting, and preserve links and human edits. If a file disappears or is renamed, flag the source change rather than deleting associated tasks or processed notes.

Assign the owning company/project explicitly. When the evidence does not identify it, keep routing unresolved and ask for clarification. The recording host can differ from the host that owns a development project: retain the source link and resolve the actual project/host binding before intake. Never duplicate tasks or transcripts across hosts merely because the same meeting is visible to them.

## Planned meeting processing

Talat handles recording, transcription, summaries and vault export. **`ingest-meeting` remains a proposed workflow step, not an installed skill or automatic plugin feature.** Its responsibilities would be:

1. Reconcile completed exports with durable ingestion receipts. Keep unreadable, incomplete or changed sources visible and retryable.
2. Read the source and create a separate context note. Retain the source transcript link, distinguish recorded decisions from inferred actions, and preserve your corrections.
3. Resolve project, feature and daily-note links. Keep one writer for each generated record and avoid competing daily-note updates.
4. Present proposed actions with the owner and date actually stated in the meeting. Apply normal clarification, acceptance criteria and project authorization before intake.
5. Pass accepted work into the owning host's existing Mission Control flow and configured Jira or Azure DevOps mapping. Recording a suggestion does not authorize implementation, tracker writes or delivery.

Morning and daytime coordinators can later reconcile unprocessed exports and proposed commitments; daily summaries can report pending ingestion and link processed meetings. Those checks should use the same receipts as event-driven processing, so a schedule and an export notification cannot create duplicate work. Meeting capture stays independent of an open Paseo conversation and should not delay the first software-factory pilot.

## Optional future event delivery

Start with the folder action. If a reliable processing trigger is needed later, Talat also documents a [webhook integration](https://talat.app/docs/integrations/webhook) with Markdown or JSON delivery. JSON includes a meeting `id` and timing information, with content sections controlled by its configuration.

A Mission Control receiver is not implemented. Before adopting one, define authenticated host routing, deduplication by source host and meeting ID, durable receipts, bounded retries and folder reconciliation after missed events. Keep the folder export as evidence. Do not assume the webhook's retry policy guarantees delivery or that a successful request establishes task readiness.

## Verification order

| Check | Evidence required |
|---|---|
| Export setup | A finished Talat meeting appears in the intended host's vault with a useful title, transcript and the selected summary/notes. Obsidian and Mission Control Docs can open it. |
| Audio on another setup | Both local and remote speech are present using that host's actual meeting app and audio devices. |
| Source preservation | Processing writes a separate note; the exported transcript and your manual edits remain intact. |
| Reliable ingestion, once built | Repeated exports, title/path changes, backfill, a restart and an unavailable agent provider preserve one logical meeting and recoverable pending work. |
| Project and task intake, once built | Confirmed project/host routing creates only the approved work, with source links and no duplicate Jira/Azure DevOps items. |

The user has confirmed capture quality in their working Talat setup. Vault export verification and the planned ingestion checks have not been performed by this documentation change. Expand to another meeting host after verifying its export and routing behavior.
