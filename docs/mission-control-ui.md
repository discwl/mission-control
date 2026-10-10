# Mission Control UI direction

Updated 2026-09-23 after the Attention, task board, and document screenshots.

## Layout

The host rail is shared navigation. Each tab owns the main pane:

| Tab | Main pane | Secondary content |
| --- | --- | --- |
| Workspaces | Searchable project/workspace list | Workspace inspector and agent cards |
| Attention | Cross-host queue, host/project filters, workspace identity on each item | Selected workspace inspector |
| Tasks | Searchable list or four-lane board | Selected task details in a Paseo dialog/sheet |
| Docs | Whole-vault file tree beside a Markdown editor/preview | Folder management and Obsidian setup |

Tasks and Docs own the main pane. Tasks has a host/project/workspace context bar and **Change workspace** picker. Docs opens the installation host's entire `C:\dev-vault` without requiring a workspace selection; its header identifies the owning host and path. The host rail is hidden in Docs so the file tree and editor have the available width. On compact screens, **Browse files** opens a bounded file tree above the full-width editor. Task details still link directly to their files in this same vault tree.

Task cards show title, lifecycle status, a short criteria excerpt, and update time. The detail dialog contains full criteria, status actions, latest run evidence, the agent task command, and a link into that task's documents. The add-task form is a separate dialog/sheet.

The board has Inbox, Doing, Review, and Delivered lanes. Lanes expand to use wide screens and scroll horizontally when there is less room. Status changes are explicit actions in task details; there is no drag-and-drop yet.

Attention's horizontal filters have a bounded 48px row and 44px chips. Do not let horizontal React Native ScrollViews consume the vertical flex remainder.

## Host ordering and project headings

Drag a host's grip handle to change its position. The list scrolls near its edges during dragging. Tap the handle for **Move earlier** / **Move later** controls. Desktop ordering is vertical; compact screens use a horizontal host strip.

The order is saved in Mission Control's host-scoped `layout` settings on the installation host (personal), using stable server IDs and revision checks. Filtering reorders only visible slots. Hidden and temporarily unpaired hosts retain their positions, and newly paired hosts append. Reordering does not change the selected host. Save failures roll back and offer **Reload order**.

Project group headings use a folder icon, stronger type, an accent border, and a visible workspace count.

Project headings also have a grip handle: drag to reorder, or activate it for **Move earlier** / **Move later**. The page scrolls at its edges while dragging. Project order is saved separately for each roster host in the installation's `layout` settings. Filtering moves only visible slots; hidden and temporarily absent projects keep their places, and new projects append. Failed saves roll back and offer **Reload project order**.

In Workspaces, **Show** and **Label** are single-choice pill buttons. The **Project** dropdown supports multiple checked projects and stays open while you select them. An empty selection means **All projects**. Project selections combine with search, Show, and Label; **Clear filters** resets all four.

## Archive and close actions

The workspace inspector offers **Archive workspace**, an archive icon for each agent, and a **Terminals** list with **Close terminal** actions. Attention cards also include the agent archive icon. Hover or focus the icon for its explanation; tapping opens confirmation. Every confirmation identifies the host and resource, and is disabled when that host is offline.

These actions use Paseo's public SDK on the selected host. Workspace archiving runs native cleanup, stops its agents and terminals, and can remove an owned worktree; resolve outstanding Git work first. Agent archiving removes it from active lists and stops its session. Terminal closing ends the shell and running command; it is not a resumable archive. Dev-vault task folders are kept. SDK errors remain visible, and roster/terminal queries refresh after success or partial cleanup failure.

## Agent details

All displayed dates use local time in `MM/DD/YY, h:mm AM/PM` format, without seconds. Updated time stays visible. Creation and last-prompt timestamps are behind an information button: hover/focus on desktop, tap on touch devices.

Subagent presentation uses an indented card and an **Open parent** link when an explicit parent relationship exists. Roles are shown only from `mission-control.role` labels; parenthood does not establish an orchestrator role.

Paseo 0.9.1's cross-host agent roster does not expose automatic parent relationships. The plugin accepts a returned `parentAgentId` when available, or the explicit label `mission-control.parent-agent-id`. Existing unlabeled agents cannot be reliably grouped yet. Provider-internal workers that are not Paseo agent records are also outside this list.

`useAgent` and `useWorkspace` are workspace-panel hooks. Calling them in a sidebar surface throws `Plugin state hooks must run inside a workspace panel`; never use them to enrich this sidebar. Automatic hierarchy needs a public roster API enhancement or a separately designed lifecycle-backed metadata adapter.

## Documents and Obsidian

The tree starts at the vault root, showing Daily, Projects, Tasks, Templates, root notes, attachments, settings, and any other files. Folders load on expansion, including nested project documents and all run history. **Vault root** and **Up a folder** provide navigation; the current folder also has a file list. Task shortcuts resolve the actual document location, including legacy flat `Tasks/task_<id>.md` records.

**New note**, **New folder**, **Rename or move**, and **Move to trash** manage ordinary vault content. Names preserve case and spaces. Paths are relative to the vault and parents must exist. Trash goes to `.trash/<unique-id>/<name>` inside the vault, with a confirmation and recovery location; there is no permanent delete action. Renaming/moving does not rewrite links in other notes.

Host identity, task metadata, canonical task folders, run evidence, Obsidian/Git settings, trash, and internal lock files are protected. Symlinks/junctions are listed but never followed. Markdown saves use content revisions and the existing task writer's lock for task notes. Move/trash actions require matching metadata revisions. Drafts and in-flight save guards survive tab changes within the current plugin session; copy/save before a full app/plugin reload. External file changes produce an error and retain the draft rather than silently overwriting it.

The editor provides Markdown source and a lightweight preview (headings, lists, basic inline formatting, code blocks), with a 200 KB UTF-8 editing limit. Common text formats are read-only; PNG/JPEG/GIF/WebP files up to 2 MB have image previews. Other files remain listed with metadata. This does not embed Obsidian, render community plugins, or implement wiki-links/backlinks/graph views.

**Set up Obsidian** distinguishes an existing folder, a prepared vault (`.obsidian`), and registration in the host's Obsidian app. **Initialize vault** creates the folder/settings non-destructively, preserving existing files and settings. Registration remains the supported one-time app action: **Open vault manager → Open folder as vault → C:\dev-vault**, followed by **Check again**. The host's Obsidian registry is only read for advisory status and is never rewritten.

**Open vault in Obsidian** opens the whole vault; **Open file in Obsidian** includes the encoded actual relative file path. They use React Native Linking and `obsidian://open?vault=<vault name>&file=<relative path>`. An unprepared or known unregistered vault directs the user to setup instead of immediately opening a broken link. The setup dialog also offers **Open vault on this device** because the viewing device's vault registration may differ from the host's. Obsidian opens on the client device, which needs a matching registered local/synced vault. This action does not synchronize a remote host's files. Save pending edits before opening and reload after external edits.

References: [Obsidian URI](https://obsidian.md/help/Extending%2BObsidian/Obsidian%2BURI), [Paseo plugin reference](https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/reference.md).

Keep the first integration file-based. A richer Markdown editor, wiki-link navigation/backlinks, and document search can be later additions after these flows settle. Keep remote vault access explicit per host.

## Verification

- Plugin TypeScript check passed.
- Development Flow CLI tests passed (2).
- Concurrent task/document revision test passed (1).
- Live Paseo browser checked at 1600 x 1000 and 390 x 844: Tasks list/board, task dialog/sheet, creation, status update, task-to-Docs navigation, tree expansion, document creation/edit/save, unsaved-file-switch guard, and read-only run evidence.
- Agent date tooltip tested; updated time remains on the card. Filter chips measured 44px high.
- Browser has only personal paired. The user's nine-host desktop setup, automatic parent links, physical mobile keyboard/gesture behavior, and launching the installed Obsidian application are not verified by these checks.

The verification task is `task_ffa5f8d9-3571-4ea3-a0cf-c39403cb4160`, linked to the development-flow workspace on personal. Its `verification.md` was created and saved through the UI.

### Host ordering and archive follow-up (2026-09-23)

- Plugin typecheck and all six `client/host-management.test.mjs` checks passed: filtered ordering, absent/new hosts, date format, resource dispatch, and failure handling.
- Isolated nine-host fixture exercised real pointer dragging, edge autoscroll, filtered order preservation, persistence after reload, and move controls. At 390 x 844, simulated touch events verified horizontal reordering and the native sheet was checked. The fixture installation was removed afterward.
- The running Mission Control UI verified project headings, short dates, icon-only agent archive controls, the explanatory tooltip, and cancelling agent confirmation. No existing agent was archived as part of testing.
- A temporary local workspace was archived through Mission Control; it disappeared and the inspector cleared. A disposable terminal was closed through Mission Control and the daemon terminal list confirmed it was gone.
- These checks cover personal. The user's multi-host desktop and physical mobile gestures still need real-device use.

### Whole-vault Docs and Obsidian setup follow-up (2026-09-23)

- Typecheck and 14 automated checks passed: eight vault backend checks plus the six existing host/action checks. Vault checks cover non-destructive initialization, advisory app registration, full-folder browsing, editable notes, protected records, stale writes/moves, shared task locks, path/junction escapes, previews/size limits, actual task paths, and recoverable trash.
- Live personal browser checks at 1600 x 1000: Docs opens without selecting a workspace; created a folder and note under Daily; edited and saved it; retained its draft across tab changes; blocked leaving a dirty file; renamed it; refused a save after an external edit while retaining the draft; discarded/reloaded successfully; moved the disposable folder to vault trash. No existing user note was changed.
- Task details still open their document in the whole-vault tree. Task metadata was read-only, with no edit action. General root files remain available alongside Tasks.
- At 390 x 844, the file tree opens in a bounded 360px region and hides after file selection. Browser geometry checks found no horizontal overflow; visible file and setup actions have 44px targets. The setup dialog and Markdown preview were exercised in the compact viewport.
- Paseo screenshot capture returned `screenshot_no_frame`; visual screenshots and physical mobile gestures were unavailable in this session. The live browser controls, DOM layout, and file results were checked instead.
- `C:\dev-vault` initially already had an empty `.obsidian` folder but was absent from Obsidian's application registry. Obsidian CLI `vaults verbose` confirmed that distinction. The setup flow correctly intercepted Open vault and explained registration. Desktop Computer Use failed because its native pipe was unavailable; completing the native Open folder as vault picker requires the user. URI dispatch from the background browser alone does not prove the external app opened.
- The disposable browser fixture is recoverable at `.trash/9137fb15-a211-4f7a-9fa3-37fd5f68b526/Mission Control browser check/`. Task records and evidence were not changed by this verification.

### Obsidian registration and extra-window fix (2026-09-23)

- The user registered `C:\dev-vault` in Obsidian. CLI checks confirmed the vault; Mission Control's refreshed setup reports it as registered and the warning disappears.
- Opening Obsidian also left a blank Paseo window. Live instrumentation reproduced `window.open(uri, '_blank', 'noopener')`: [React Native Web Linking](https://github.com/necolas/react-native-web/blob/master/packages/react-native-web/src/exports/Linking/index.js) defaults its optional target to `_blank`.
- The shared Obsidian opener now explicitly uses `_self` on web/desktop, preserving the Linking instance binding. Native iOS/Android still uses its normal one-argument URL handler. The vault, file, and vault-manager actions all use this opener. Do not substitute Paseo's HTTP(S)-only `openExternalUrl` for these custom protocol links.
- Typecheck passed and Mission Control was reloaded successfully. Live checks recorded `_self` for all three actions, with no plugin errors; the file-opening attempt retained the current Paseo route and Docs content. The background browser could not confirm an Obsidian app launch (CLI reported it was not running), so external-app behavior still needs the user's desktop click. No native desktop screenshot was available.
