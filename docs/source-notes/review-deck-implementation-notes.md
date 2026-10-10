# Review Deck implementation notes

25 September 2026. Source read (not run): installed Review Deck checkout `3b1c24f`, MIT licence. Companion to [section 9 of the Mission Control spec](../mission-control-plugin-spec.md#9-review-deck-adoption-and-jev-decision-layer-plan) and the [earlier adoption notes](review-deck-and-jev-research.md). Adapted code must keep the MIT notice.

## How its features work

| Feature | How Review Deck does it | What we do |
|---|---|---|
| High / Informational labels | `server/diff/FindingDetector.ts`: regexes over each hunk's added lines. High: exported API, concurrency, crypto, DB migration. Medium: error handling, loops with allocation. Otherwise Informational. File label = highest hunk label. Paths are ignored. | Keep the idea and categories. Fix the regexes (word boundaries: `hash` currently matches `HashMap`, `mod` counts as crypto). Add path rules: tests, docs, lockfiles and generated files lower; auth, migrations and config higher. Stable finding IDs. |
| Rule analysis | Deterministic "Verified facts": file, enclosing symbol, language, +/- counts, rule details, suggested checks for High. | Reuse `lang/languages.ts` for symbol hints. Add Gortex impact (callers, affected tests) as verified facts. |
| AI review file / block | Creates a child agent with `parent`, `autoArchive`. The prompt demands VERIFIED FACTS / AI INFERENCE / HUMAN VERIFICATION headings; results are parsed and polled every 3 s for up to 5 minutes. **Read-only is only a sentence in the prompt**; children blocked on a permission are orphaned. | Start the reviewer in a read-only provider mode, label it with task/run IDs, cancel on timeout or permission, and save results in the run folder. Reuse `parseReviewSections`. Keep facts and AI inference visually separate. |
| Mark reviewed; To review / Reviewed | Per-hunk marks keyed by a content hash of path plus hunk body, so they survive unrelated edits and line shifts and drop when the hunk itself changes. "Mark file reviewed" makes one RPC per hunk. | Adopt the content-hash carry-over. Store marks per task run in the vault, with a batch "mark file". Files with no hunks (binary, rename-only) get a file-level mark. |
| Diff collection and snapshot | `git diff HEAD` plus untracked files; fingerprint of status and diffs; full rescan every 3 s. Scopes: working, staged, branch, commits. | Reuse the GitRunner/DiffParser approach with fixes: empty-tree base when there are no commits; `--end-of-options` and ref validation (currently `--output=` can be injected); fixed `a/` `b/` prefixes regardless of user git config; cheap status check before a full rescan. |
| Reject hunk / Revert file | `git apply --reverse` after fingerprint checks. Reject has no confirmation, can delete untracked files, and leaves staged copies in the index. | Later, behind confirmation, with a backup of untracked files and index handling. |
| Comments and "Process comments" | One comment per file anchored to a hunk; the project queue is sent to an agent and **cleared as soon as the send is accepted**. The agent's COMMENT OUTCOMES are never read. | Comments become findings in `findings.json` and go through Needs you → submitted → awaiting verification → resolved. Nothing is cleared on send. |
| Diff layouts | Diff view (per block), Block file view, Full changes view; Split/Unified. Every line is a React Native `View`, not virtualized, so large files lag. The "No newline at end of file" marker shifts line numbers. | Same three layouts. Use a virtualized list, green additions, horizontal scroll for long lines, and fix line-number handling. |
| Status badge | The FAILED/DONE badge is the **agent's** status, not the review's, which is why it can say FAILED over a good diff. | Show review state (to review / reviewed / stale / error) and agent state separately. |

## Build order for the Mission Control Review panel

1. **Read-only diff:** server git collection with the fixes above; changed-files list with labels and To review / Reviewed groups; Diff and Full changes views, Split/Unified; truthful snapshot state.
2. **Mark reviewed** with content-hash carry-over, and the composer bubble (**Review · N files · N open**).
3. **Comments as findings**, sent through Needs you.
4. **Rule analysis** with Gortex facts, then **AI review** in a read-only child agent.
5. Block file view, reject/revert with confirmations, and settings.
